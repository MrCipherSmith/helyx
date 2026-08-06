/**
 * One restart at a time.
 *
 * `bounce`, `host_restart` and `full_restart` spawn their work detached and used
 * to report success immediately. The only thing standing between an operator and
 * two concurrent restarts was a database check for a row of *the same name* in
 * `pending` or `processing` — and the row went `done` in about a second, while
 * the work ran for minutes. Different names were never excluded from each other
 * at all, so "🔄 Bounce" followed by "♻️ Полный рестарт" ran two
 * `tmux kill-session` sequences over one session name, each tearing down what
 * the other had just built, both logs reporting success.
 *
 * ## Why a file and not the database
 *
 * The guard has to hold in the situation it exists for, and that situation is a
 * stack that is already broken. `/up` through `scripts/host-ingress.ts` is armed
 * exactly when the bot is confirmed dead, and when the whole stack is down
 * Postgres is down with it. A guard that cannot be consulted at the moment it
 * matters is not a guard. Both spawners — the admin daemon and the host ingress
 * — run on the host, so a file is visible to both with the database in any
 * state.
 *
 * Taking it is `O_CREAT | O_EXCL`: the create either wins or fails, in one
 * syscall. A read-then-write would leave a window in which two takers both saw
 * an empty path and both proceeded, which is the race this file exists to close.
 *
 * ## Why staleness is a timestamp and not a heartbeat
 *
 * A restart that dies leaves its file behind, and a lease nobody can break is a
 * stack nobody can restart — worse than the race it replaced. A heartbeat is not
 * available here: the work is detached and routinely kills the process that
 * would have to send one (`host_restart` ends by restarting the daemon itself).
 * So the lease carries when it was taken, and one older than the longest a
 * restart can take may be broken by the next taker, which says in the log that
 * it did so.
 */

import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * How long a restart may hold the lease before the next taker may break it.
 *
 * Set from the longest thing a restart does, with margin: `full_restart`
 * rebuilds a Docker image and then bounces every session, and a cold build on a
 * loaded host is minutes rather than seconds. Too short and a live restart has
 * the ground taken from under it; too long and a crashed one blocks recovery for
 * as long as the number says. Fifteen minutes is well past any restart observed
 * here and well inside an operator's patience.
 */
export const LEASE_EXPIRY_MS = 15 * 60 * 1_000;

/**
 * Where the lease lives.
 *
 * Absolute and derived from one place: the daemon and the host ingress are
 * separate processes with their own working directories, and a relative path
 * would have them take different files and exclude nothing. Overridable so a
 * test can point it at a temporary directory without touching the real one.
 */
export const DEFAULT_LEASE_PATH = process.env.HELYX_RESTART_LEASE
  ?? join(process.env.XDG_RUNTIME_DIR || tmpdir(), "helyx-restart.lease");

/**
 * How long a takeover waits before checking it still holds what it took.
 *
 * Only the stale path pays it, and only after a restart died without releasing.
 * See the reasoning in `takeRestartLease`.
 */
export const TAKEOVER_SETTLE_MS = 50;

/** Block for `ms`. Sleeping is the point — a takeover must not race itself. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RestartLease {
  /** Which command took it — named in the refusal, so a refusal says what to wait for. */
  owner: string;
  /** When it was taken, epoch ms. */
  takenAt: number;
  /**
   * Unique per take, so a taker can tell its own lease from an identical-looking
   * one written by somebody else in the same millisecond. Only the stale-takeover
   * path needs it; see `takeRestartLease`.
   */
  token?: string;
}

export type TakeResult =
  | { ok: true; broke: RestartLease | null }
  | { ok: false; held: RestartLease };

/** The lease currently on disk, or null when there is none or it is unreadable. */
export function readRestartLease(path: string = DEFAULT_LEASE_PATH): RestartLease | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RestartLease>;
    if (typeof parsed.owner !== "string" || typeof parsed.takenAt !== "number") return null;
    // The token comes back too: a takeover verifies it still holds what it took
    // by comparing it, and a reader that dropped it would make every takeover
    // conclude it had lost.
    return {
      owner: parsed.owner,
      takenAt: parsed.takenAt,
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
    };
  } catch {
    // Absent, half-written, or corrupt. All three mean the same thing to a
    // taker: there is nothing here that can be trusted to be holding the lease.
    return null;
  }
}

/** Milliseconds a lease has been held. */
export function leaseAgeMs(lease: RestartLease, now: number = Date.now()): number {
  return Math.max(0, now - lease.takenAt);
}

/**
 * Take the lease, or report who holds it.
 *
 * `broke` names the previous holder when a stale lease was taken over, so the
 * caller can log that a restart which never finished has been written off rather
 * than leaving it to be inferred from a gap in the log.
 */
export function takeRestartLease(
  owner: string,
  path: string = DEFAULT_LEASE_PATH,
  now: number = Date.now(),
  settle: (ms: number) => void = sleepSync,
): TakeResult {
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const write = (): void => {
    // wx: create-or-fail. The exclusivity is the whole point — see the header.
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, JSON.stringify({ owner, takenAt: now, token }));
    } finally {
      closeSync(fd);
    }
  };

  try {
    write();
    return { ok: true, broke: null };
  } catch {
    // Somebody else got there first — or left a file behind when they died.
  }

  const held = readRestartLease(path);
  if (held && leaseAgeMs(held, now) < LEASE_EXPIRY_MS) return { ok: false, held };

  // Stale, or unreadable and therefore untrustworthy.
  //
  // This is the one path where `O_EXCL` alone does not settle it, and review
  // was right to push on it. Two takers can both read the same stale lease,
  // both unlink it, and both create: the second unlink removes the *first
  // taker's fresh lease*, so both walk away believing they hold it — which is
  // exactly the concurrent restart this file exists to prevent.
  //
  // So a takeover is not complete when the write succeeds. The writer settles,
  // then reads back: the file carries a token unique to this take, and if what
  // is on disk is not that token, somebody unlinked us and we lost. The settle
  // is a bound, not a proof — two takers reach the unlink within microseconds
  // of each other, and the delay is orders of magnitude past that — and it is
  // stated as a bound rather than dressed up as a guarantee. It costs nothing
  // in the normal case, which never reaches this path at all: a takeover only
  // happens when a previous restart died without releasing.
  try {
    unlinkSync(path);
  } catch {
    // Already gone; the write below decides.
  }
  try {
    write();
  } catch {
    const winner = readRestartLease(path);
    return winner ? { ok: false, held: winner } : { ok: false, held: { owner: "unknown", takenAt: now } };
  }

  settle(TAKEOVER_SETTLE_MS);
  const mine = readRestartLease(path);
  if (mine?.token !== token) {
    return { ok: false, held: mine ?? { owner: "unknown", takenAt: now } };
  }
  return { ok: true, broke: held };
}

/**
 * Release the lease.
 *
 * Releasing one that is not held is not an error: the detached work releases in
 * a `finally`, and a path that never took it must not turn a completed restart
 * into a failed one.
 */
export function releaseRestartLease(path: string = DEFAULT_LEASE_PATH): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to release.
  }
}

/** A refusal an operator can act on: who holds it, and for how long. */
export function heldMessage(held: RestartLease, now: number = Date.now()): string {
  const seconds = Math.round(leaseAgeMs(held, now) / 1000);
  const age = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
  return `restart already running: ${held.owner}, started ${age} ago`;
}

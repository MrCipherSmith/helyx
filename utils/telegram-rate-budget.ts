/**
 * Shared Telegram rate budget across concurrent `channel.ts` subprocesses.
 * Leaf module — no imports from `channel/`.
 *
 * ~10 projects (helyx, keryx, arena, goodai, …) each run their own `channel.ts`
 * subprocess, and every one of them sends to the *same* Telegram bot token and
 * chat_id — the group is one supergroup, project topics are just
 * `message_thread_id`s inside it, and Telegram enforces its rate limit per
 * chat_id, not per topic. Each subprocess already throttles its own status
 * edits and typing indicator, but none of them know about each other, so the
 * combined traffic can still exceed Telegram's real per-chat budget even when
 * every individual session is well behaved. See flow 064's description.md.
 *
 * ## Why a lease, not an acquire-per-send
 *
 * All ~10 subprocesses already share one Postgres instance (session leases
 * live there too), so the natural fix is a Postgres-backed token bucket. A
 * naive version acquires one token per outbound call — but a typing indicator
 * alone ticks every 4s per active session, and ~10 subprocesses already run
 * concurrently, so that would add a new, previously-unprecedented DB round
 * trip on every tick, with no precedent in this codebase for that call volume
 * (`memory/db.ts`'s pool is `max: 10`, sized for occasional queries, not a
 * per-tick heartbeat times ten processes).
 *
 * Instead, each subprocess leases a small batch of tokens on a ~5s timer
 * (`REFRESH_INTERVAL_MS`) — one atomic `UPDATE ... RETURNING` — and spends
 * that local allowance in-process between refreshes. This cuts the new DB
 * call volume from 1:1-with-sends to roughly 1-per-lease-window, while still
 * enforcing one real shared budget with ~5s granularity — the same order as
 * the existing 8s status-edit floor (`channel/status.ts`'s
 * `MIN_EDIT_INTERVAL_MS`), so this does not introduce a new class of lag.
 *
 * ## Why `UPDATE ... RETURNING`, not `pg_advisory_lock`
 *
 * This codebase deliberately moved away from advisory locks to a
 * lease-column + TTL pattern for session ownership, specifically to avoid
 * orphaned locks surviving a pool reconnect (CHANGELOG.md, "Lease-Based
 * Session Ownership"). `leaseBudget` follows the same atomic-`UPDATE` shape
 * already used by `utils/action-approval-grant.ts`'s `presentGrant` — the row
 * is locked for the width of one statement, never held across a round trip.
 */

import postgres from "postgres";
import { sql as defaultSql } from "../memory/db.ts";
import { channelLogger } from "../logger.ts";

/**
 * Two lanes, not one shared pool. A single bucket let a typing tick — purely
 * cosmetic, resent every few seconds per active session regardless of
 * whether anyone is looking — compete on equal footing with an actual
 * `reply` send, the one thing CLAUDE.md says the operator actually reads.
 * Under sustained load from ~10 concurrent sessions that cosmetic traffic
 * won the competition often enough to matter: on 2026-08-31, keryx's real
 * answers sat undelivered for 15-30 minutes, flushed only when an unrelated
 * bot restart happened to run `deliverPendingReplies`.
 *
 * Splitting the pool into a priority lane (everything through
 * `telegramRequest` by default — replies, status edits, the rest of
 * `channel/telegram.ts`) and a background lane (only the one caller proven
 * to cause the starvation: `utils/typing.ts`'s tick) makes that structurally
 * impossible for typing specifically — it has no way to touch priority's
 * tokens, regardless of how much of it there is. Scoped to the one
 * concretely-evidenced offender rather than every plausibly-cosmetic send:
 * status edits already self-throttle on an 8s floor and were not shown to be
 * the actual driver, so moving them too would be guessing at a fix for a
 * problem not yet demonstrated to exist.
 *
 * The two capacities still sum to Telegram's own documented per-chat budget
 * (flow 064 description.md: "~20/min") — this reallocates who gets to spend
 * it, not how much there is to spend. Raising the total risks trading a
 * graceful internal wait for a real Telegram 429, which this module exists
 * to prevent.
 */
export interface BudgetLane {
  bucket: string;
  capacity: number;
  refillPerSec: number;
}

/** Everything through `telegramRequest` by default — `reply`, status edits, the rest of `channel/telegram.ts`. */
export const PRIORITY_LANE: BudgetLane = { bucket: "global_priority", capacity: 14, refillPerSec: 14 / 60 };

/** `utils/typing.ts`'s tick only — the one caller proven to starve real replies. */
export const BACKGROUND_LANE: BudgetLane = { bucket: "global_background", capacity: 6, refillPerSec: 6 / 60 };

/** How often each subprocess asks Postgres for a fresh local allowance. */
const REFRESH_INTERVAL_MS = 5_000;

/** How many tokens a subprocess asks for per lease window. */
const LEASE_REQUEST = 4;

/**
 * If `leaseBudget` itself errors or hangs, grant this many local sends anyway
 * (AC4) — small and conservative, but never zero: a DB hiccup must not
 * silently mute every project's status updates.
 */
const FAILOPEN_GRANT = 2;

/** Guards a single `leaseBudget` call so a hung connection cannot delay the next refresh past REFRESH_INTERVAL_MS. */
const LEASE_TIMEOUT_MS = 3_000;

export interface LeaseResult {
  /** Tokens actually granted — always an integer, never more than requested. */
  granted: number;
}

/**
 * One atomic lease against one lane's budget.
 *
 * Refills by elapsed time since `updated_at` and grants up to `n` whole
 * tokens from the result, all inside one `UPDATE ... FROM (SELECT ... FOR
 * UPDATE) RETURNING` statement — the `FOR UPDATE` matters here, not just as
 * belt-and-suspenders: the grant is computed once in the subquery and reused
 * by both the `SET` and `RETURNING` clauses, and without the row lock two
 * concurrent leases could compute their grant from the same pre-refill
 * balance and both spend it (the double-spend AC2 exists to rule out).
 *
 * `db` defaults to this project's shared pool but takes an override so a test
 * can lease against a disposable database — same shape as `runMigrations`.
 */
export async function leaseBudget(n: number, lane: BudgetLane, db: postgres.Sql = defaultSql): Promise<LeaseResult> {
  if (!Number.isFinite(n) || n <= 0) return { granted: 0 };

  const [row] = await db<{ granted: number }[]>`
    UPDATE telegram_rate_budget AS b
    SET
      tokens = calc.available - calc.grant,
      updated_at = now()
    FROM (
      SELECT
        LEAST(
          ${lane.capacity}::numeric,
          tokens + GREATEST(0, EXTRACT(EPOCH FROM (now() - updated_at))) * ${lane.refillPerSec}::numeric
        ) AS available,
        FLOOR(LEAST(
          ${n}::numeric,
          LEAST(
            ${lane.capacity}::numeric,
            tokens + GREATEST(0, EXTRACT(EPOCH FROM (now() - updated_at))) * ${lane.refillPerSec}::numeric
          )
        )) AS grant
      FROM telegram_rate_budget
      WHERE bucket = ${lane.bucket}
      FOR UPDATE
    ) AS calc
    WHERE b.bucket = ${lane.bucket}
    RETURNING calc.grant::int AS granted
  `;
  return { granted: row ? Number(row.granted) : 0 };
}

// ---------------------------------------------------------------------------
// The local, in-process allowance — what channel/telegram.ts and
// utils/typing.ts actually gate sends on. `leaseBudget` above is the DB
// primitive this spends from a batch at a time.
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`leaseBudget timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface LocalAllowanceOptions {
  /** Injectable for tests; production passes `leaseBudget` itself. */
  lease: (n: number) => Promise<LeaseResult>;
  leaseRequest?: number;
  refreshIntervalMs?: number;
  failOpenGrant?: number;
  leaseTimeoutMs?: number;
  /** Called on a fail-open — production logs it, tests assert on it. */
  onFailOpen?: (err: unknown) => void;
}

export interface LocalAllowance {
  /**
   * Resolves once a send has a reserved local token, spending it. With no
   * `timeoutMs`, never rejects — when the local allowance is exhausted this
   * waits for the next refresh instead of erroring, mirroring
   * `telegramRequest`'s existing 429 wait-and-retry shape so callers don't
   * need their own retry logic.
   *
   * With `timeoutMs`, rejects once that many milliseconds have elapsed
   * without a token becoming available — for callers like `telegramRequest`
   * that have their own total-call deadline and must not hang past it just
   * because the shared budget is starved.
   */
  acquire(timeoutMs?: number): Promise<void>;
  /** Tokens currently held locally — for tests and diagnostics. */
  remaining(): number;
  /** Run a refresh immediately. Production relies on the timer; tests call this directly instead of waiting on real time. */
  refreshNow(): Promise<void>;
  /** Stop the refresh timer. */
  stop(): void;
}

/**
 * Build a local allowance backed by `options.lease`. Exported (rather than
 * only the process-wide singleton below) so a test can exercise the wait/
 * fail-open behaviour without a real timer or a real database.
 */
export function createLocalAllowance(options: LocalAllowanceOptions): LocalAllowance {
  const leaseRequest = options.leaseRequest ?? LEASE_REQUEST;
  const refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  const failOpenGrant = options.failOpenGrant ?? FAILOPEN_GRANT;
  const leaseTimeoutMs = options.leaseTimeoutMs ?? LEASE_TIMEOUT_MS;

  let tokens = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let waiters: Array<() => void> = [];

  function wakeWaiters(): void {
    const toWake = waiters;
    waiters = [];
    for (const wake of toWake) wake();
  }

  async function refreshNow(): Promise<void> {
    try {
      const { granted } = await withTimeout(options.lease(leaseRequest), leaseTimeoutMs);
      tokens = granted;
    } catch (err) {
      // Fail-open (AC4): a DB hiccup must not block every project's status
      // updates indefinitely. A conservative local allowance keeps sends
      // moving until the next refresh, which tries the lease again.
      tokens = failOpenGrant;
      options.onFailOpen?.(err);
    } finally {
      wakeWaiters();
    }
  }

  function ensureStarted(): void {
    if (timer) return;
    timer = setInterval(() => { void refreshNow(); }, refreshIntervalMs);
    void refreshNow();
  }

  /**
   * Resolves on the next refresh. With `deadlineMs` given, rejects instead
   * once that absolute timestamp passes without a refresh — and removes its
   * own waiter so a timed-out call does not leave a dangling resolver that
   * `wakeWaiters` would still call (harmlessly, but forever) on every future
   * refresh.
   */
  function waitForRefresh(deadlineMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      waiters.push(wake);
      if (deadlineMs !== undefined) {
        const remaining = Math.max(0, deadlineMs - Date.now());
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = waiters.indexOf(wake);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`rate-budget wait exceeded its ${remaining}ms deadline`));
        }, remaining);
      }
    });
  }

  async function acquire(timeoutMs?: number): Promise<void> {
    ensureStarted();
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    while (tokens <= 0) {
      // Recomputed from the fixed `deadline` on every iteration — not
      // `timeoutMs` again, which would keep resetting the clock and never
      // actually time out under repeated exhaustion.
      await waitForRefresh(deadline);
    }
    tokens -= 1;
  }

  return {
    acquire,
    remaining: () => tokens,
    refreshNow,
    stop: () => {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

export type SendPriority = "priority" | "background";

const sharedByPriority: Record<SendPriority, LocalAllowance | null> = {
  priority: null,
  background: null,
};

function sharedAllowance(priority: SendPriority): LocalAllowance {
  if (!sharedByPriority[priority]) {
    const lane = priority === "priority" ? PRIORITY_LANE : BACKGROUND_LANE;
    sharedByPriority[priority] = createLocalAllowance({
      lease: (n) => leaseBudget(n, lane),
      onFailOpen: (err) => {
        channelLogger.warn({ err, priority }, "telegram-rate-budget: leaseBudget failed — granting a conservative local allowance (fail-open)");
      },
    });
  }
  return sharedByPriority[priority]!;
}

/**
 * The gate `channel/telegram.ts`'s `telegramRequest` and
 * `utils/typing.ts`'s `startTypingRaw` call before each actual outbound
 * request. Lazily starts the relevant lane's refresh timer on first use, so
 * importing this module has no side effect until a send is actually
 * attempted.
 *
 * Defaults to `"priority"` — before this parameter existed, every caller
 * shared one pool, so defaulting to the lane closest to that prior behavior
 * means `telegramRequest` (and everything built on it: `reply`, status
 * edits, everything in `channel/telegram.ts`) needs no changes to keep
 * working exactly as before. Only `startTypingRaw` — the one caller that is
 * unambiguously cosmetic and was concretely proven to starve real replies on
 * 2026-08-31 — opts into `"background"` explicitly. Getting this backwards
 * (marking a real send as background) reintroduces exactly the starvation
 * this split exists to prevent, so a new caller should stay on the default
 * unless it is as clearly disposable as a typing tick.
 *
 * `timeoutMs`, when given, bounds the wait: rejects rather than hanging once
 * that many milliseconds pass without that lane granting a slot.
 * `telegramRequest` passes its own remaining total-call budget so a starved
 * lane cannot hold a call open past its documented deadline.
 */
export function acquireSendSlot(timeoutMs?: number, priority: SendPriority = "priority"): Promise<void> {
  return sharedAllowance(priority).acquire(timeoutMs);
}

/**
 * Stand an allowance in for one lane's process-wide shared one; the returned
 * function puts the real one back.
 *
 * A test that drives `telegramRequest`/`startTypingRaw` end to end (a
 * stubbed `fetch`, a real call into `channel/telegram.ts`) otherwise shares
 * this module's production singletons with every other test in the same
 * `bun test` process — including their real ~5s lease windows and default
 * DB, neither of which such a test wants to depend on. Passing `null` clears
 * that lane back to its lazily-constructed default.
 */
export function setSharedAllowanceForTests(priority: SendPriority, next: LocalAllowance | null): () => void {
  const previous = sharedByPriority[priority];
  sharedByPriority[priority] = next;
  return () => { sharedByPriority[priority] = previous; };
}

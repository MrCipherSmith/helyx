/**
 * The two minutes a fold takes, written down where both halves can read it.
 *
 * Compaction is bracketed by two events in two different processes. The
 * `PreCompact` hook reaches the bot over HTTP before the fold starts
 * (`/api/hooks/pre-compact`), and the `compact_boundary` record appears in the
 * transcript after it ends, where `channel/status.ts` is already tailing. The
 * bot runs in a container; the channel runs on the host. Neither can see the
 * other's memory, and the thing that has to know — is this session silent
 * because it is folding? — is asked in both.
 *
 * So the marker is a row, and the row is `sessions.metadata`. It is a JSONB
 * column that has existed since the baseline schema and that nothing has ever
 * updated: `sessions/manager.ts` writes it once at INSERT and no other statement
 * in the repository touches it, which is why a `||` merge here cannot clobber
 * anyone. The alternative was a table and a migration for a field whose whole
 * lifetime is two minutes.
 *
 * `durationMs` was 119544 and 149137 on the two folds observed in this project's
 * own transcript on 2026-08-08. That is the measurement everything below is
 * sized against: a fold is minutes of genuine silence, and both watchdogs that
 * would call it a hang fire at five.
 */

import type postgres from "postgres";

/** What a fold looks like while it is happening. */
export interface ActiveFold {
  /** When the PreCompact hook fired, in epoch milliseconds. */
  startedAt: number;
  /** "auto" when the window filled, "manual" when something typed `/compact`. */
  trigger: string | null;
  /** How long it has been folding. */
  elapsedMs: number;
  /** How long it is allowed to fold before this stops being believed. */
  graceMs: number;
}

/** The raw marker, as it survives in `sessions.metadata.fold`. */
export interface FoldMarker {
  /** Null when no fold is in flight. */
  startedAt: number | null;
  trigger: string | null;
  /**
   * The previous fold's measured duration, kept for the next one's grace window.
   *
   * A session that has folded before has said how long its folds take, and that
   * is a better estimate than any constant chosen here — a project with a
   * million-token window folds for two minutes, one with a small window folds
   * for seconds.
   */
  lastDurationMs: number | null;
}

/**
 * How long an unfinished fold marker is worth believing, with no history.
 *
 * Four minutes against two observed folds of two and two and a half. It has to
 * cover a real fold with room to spare and stay under the five-minute watchdogs
 * it suppresses, because the failure mode on the other side is worse than a
 * false alarm: a marker left behind by a CLI that died mid-fold would otherwise
 * silence hung-session detection for that session permanently.
 */
export const FOLD_GRACE_DEFAULT_MS = 4 * 60_000;
/** No fold is this quick, so no marker is discarded this quickly. */
export const FOLD_GRACE_MIN_MS = 60_000;
/** And none is this slow. Past here the marker is stale, not the fold long. */
export const FOLD_GRACE_MAX_MS = 10 * 60_000;

/**
 * How long to wait for a fold, given how long the last one took.
 *
 * Twice the previous duration: 149137 ms becomes just under five minutes, which
 * is what the slower of the two observed folds actually needs to be safe from a
 * five-minute alarm. Clamped at both ends because the input is a number written
 * by another program into a file, and a `durationMs` of 0 or of a day is not a
 * reason to change what this decides.
 */
export function foldGraceMs(lastDurationMs: number | null): number {
  if (lastDurationMs === null || !Number.isFinite(lastDurationMs) || lastDurationMs <= 0) {
    return FOLD_GRACE_DEFAULT_MS;
  }
  return Math.min(FOLD_GRACE_MAX_MS, Math.max(FOLD_GRACE_MIN_MS, lastDurationMs * 2));
}

/** A number, or null — the column is JSONB and anything can be in it. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the marker out of whatever `sessions.metadata` holds.
 *
 * Tolerant of every shape, and not out of politeness: the column defaults to
 * `'{}'`, postgres.js has handed it back as a double-encoded string before (see
 * the v1.32.0 repair in `memory/db.ts`), and a row written by an older version
 * of this code has no `fold` key at all. None of those is a fold in progress,
 * and all of them must answer "no" rather than throw inside a watchdog.
 */
export function readFoldMarker(metadata: unknown): FoldMarker {
  const empty: FoldMarker = { startedAt: null, trigger: null, lastDurationMs: null };

  let root: unknown = metadata;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      return empty;
    }
  }
  if (!root || typeof root !== "object") return empty;

  const fold = (root as Record<string, unknown>).fold;
  if (!fold || typeof fold !== "object") return empty;
  const f = fold as Record<string, unknown>;

  return {
    startedAt: numberOrNull(f.startedAt),
    trigger: typeof f.trigger === "string" ? f.trigger : null,
    lastDurationMs: numberOrNull(f.lastDurationMs),
  };
}

/**
 * Is this marker a fold happening right now?
 *
 * Null for a marker with no start, and null for one whose start is too old to
 * believe — see `FOLD_GRACE_DEFAULT_MS`. A start in the future is also null: the
 * host and the container get their clocks from the same machine, but the value
 * crosses a process boundary as a number and a nonsensical one must not open an
 * unbounded window.
 */
export function foldFromMarker(marker: FoldMarker, now: number): ActiveFold | null {
  if (marker.startedAt === null) return null;
  const elapsedMs = now - marker.startedAt;
  if (elapsedMs < 0) return null;
  const graceMs = foldGraceMs(marker.lastDurationMs);
  if (elapsedMs > graceMs) return null;
  return { startedAt: marker.startedAt, trigger: marker.trigger, elapsedMs, graceMs };
}

/**
 * The fold this session is inside, or null.
 *
 * Asked by both watchdogs — `scripts/supervisor.ts`'s hung-session loop in the
 * container and `StatusManager.runResponseGuard` on the host — and shaped after
 * `hasOpenQuestion`, which answers the same kind of question for the same
 * reason. A database that will not answer is not a fold: failing closed here
 * would turn one bad query into a permanently mute watchdog.
 */
export async function sessionFold(
  sql: postgres.Sql,
  sessionId: number,
  now: number = Date.now(),
): Promise<ActiveFold | null> {
  const rows = await sql`
    SELECT metadata FROM sessions WHERE id = ${sessionId}
  `.catch(() => [] as unknown[]);
  const row = rows[0] as { metadata?: unknown } | undefined;
  if (!row) return null;
  return foldFromMarker(readFoldMarker(row.metadata), now);
}

/**
 * The fold has started; say so before the session goes quiet.
 *
 * Called from the PreCompact hook, which is the only thing that knows the fold
 * is coming — the transcript says nothing until it is over. Fire-and-forget at
 * the call site: the hook is holding compaction open while it waits, and a
 * marker that failed to write is a status line that stays generic, not a fold
 * that stops.
 *
 * `startedAt` is written from the bot's clock rather than `now()` in SQL so that
 * the reader on the host compares two values produced by the same kind of clock
 * — both processes read `Date.now()` on the same host.
 */
export async function startFold(
  sql: postgres.Sql,
  sessionId: number,
  trigger: string | null,
  startedAt: number = Date.now(),
): Promise<void> {
  await sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'fold',
      COALESCE(metadata -> 'fold', '{}'::jsonb) || jsonb_build_object(
        'startedAt', ${startedAt}::bigint,
        'trigger', ${trigger}::text
      )
    )
    WHERE id = ${sessionId}
  `;
}

/**
 * The fold is over, and it took this long.
 *
 * Called when the `compact_boundary` record arrives, which is the only place the
 * duration is known — Claude Code measures it and writes it down. `startedAt` is
 * removed rather than zeroed so `readFoldMarker` has one way to say "not
 * folding", and `lastDurationMs` is kept because the next fold's grace window is
 * sized from it.
 */
export async function endFold(
  sql: postgres.Sql,
  sessionId: number,
  durationMs: number | null,
): Promise<void> {
  await sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'fold',
      (COALESCE(metadata -> 'fold', '{}'::jsonb) - 'startedAt') || jsonb_build_object(
        'lastDurationMs', ${durationMs}::bigint
      )
    )
    WHERE id = ${sessionId}
  `;
}

/**
 * Mark the fold for whichever session is running in this project directory.
 *
 * The hook is given a project path and a transcript path; it has no session id,
 * because Claude Code has never heard of one. The active session for a path is
 * how the rest of the bot resolves the same thing.
 *
 * Returns the session it marked, or null when the path belongs to no live
 * session — a `claude` started by hand outside the fleet, which folds like any
 * other and has no status message to say so on.
 */
export async function startFoldForProject(
  sql: postgres.Sql,
  projectPath: string,
  trigger: string | null,
  startedAt: number = Date.now(),
): Promise<number | null> {
  const rows = await sql`
    SELECT id FROM sessions
    WHERE project_path = ${projectPath} AND status = 'active'
    ORDER BY last_active DESC
    LIMIT 1
  `.catch(() => [] as unknown[]);
  const id = (rows[0] as { id?: unknown } | undefined)?.id;
  if (typeof id !== "number") return null;
  await startFold(sql, id, trigger, startedAt).catch(() => {});
  return id;
}

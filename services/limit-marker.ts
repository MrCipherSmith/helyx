/**
 * "Not allowed to answer until 5:30pm" written down where both halves can read it.
 *
 * The same two-process problem `services/fold-marker.ts` solves, and deliberately
 * the same solution rather than a second one. The channel tails the transcript on
 * the host and is the only thing that sees `isApiErrorMessage`; the supervisor
 * alerts from inside the container and is the only thing that talks to the
 * operator. Neither can see the other's memory, and the question — is this
 * session silent because it hit a limit? — is asked in both.
 *
 * So the marker is a row, and the row is `sessions.metadata`, beside the fold
 * marker under its own `limit` key. The `||` merges in `startLimit` touch that
 * key and nothing else, so the two markers coexist: a session can be folding and
 * limited at once, and clearing either leaves the other alone.
 *
 * The reason this exists at all, measured: twelve limit events in this project's
 * transcripts between 2026-07-07 and 2026-08-08 — eleven session limits and one
 * weekly — and `isApiErrorMessage` appeared in zero lines of code. Every one of
 * those was a session that stopped answering, was found stale five minutes later,
 * and was offered a restart button that could not help, because the limit is on
 * the account and not on the process.
 */

import type postgres from "postgres";
import type { ApiErrorKind } from "../utils/context-usage.ts";

/** The raw marker, as it survives in `sessions.metadata.limit`. */
export interface LimitMarker {
  /** Which limit. Only `isLimitKind` kinds are ever written here. */
  kind: ApiErrorKind;
  /** The message as Claude Code wrote it, for the alert to quote. */
  text: string;
  /** When the channel saw the error, in epoch milliseconds. */
  startedAt: number;
  /**
   * When the limit lifts, in epoch milliseconds, or null when the text said no
   * time. Resolved on the way in — see `resolveResetAt`.
   */
  resetsAt: number | null;
  /** The transcript entry's uuid, so one event is alerted on once. */
  uuid: string | null;
}

/** A limit that is in force right now. */
export interface ActiveLimit extends LimitMarker {
  /** How long the session has been under it. */
  elapsedMs: number;
  /** When this marker stops being believed, whatever the account does. */
  expiresAt: number;
}

/**
 * How long a limit with no stated reset time is believed.
 *
 * Thirty minutes, and the number is a compromise between two failures that are
 * not symmetric. Too short and a real limit is reported as a hang while the
 * operator is already waiting it out — noise, and wrong, but visible. Too long
 * and a marker left behind by a CLI that died holding one mutes hung-session
 * detection for that session, which is a dead session nobody hears about.
 *
 * Thirty minutes is the same side of that trade `FOLD_GRACE_MAX_MS` picks for
 * folds, scaled to what it is covering: a fold is two minutes of silence and
 * gets four and a half, an unnamed limit is an unknown wait and gets half an
 * hour. Every limit text this project has ever recorded carried a reset time, so
 * this bound is the path that only runs when Claude Code changes its wording.
 */
export const LIMIT_GRACE_DEFAULT_MS = 30 * 60_000;

/**
 * The furthest ahead a stated reset time is believed.
 *
 * `parseResetTime` returns a time of day and no date, so `resolveResetAt` can
 * never legitimately produce more than twenty-four hours out. Anything beyond
 * that is a clock disagreeing with itself across the process boundary, and a
 * marker that suppressed the alarm for a week on the strength of one is exactly
 * the failure the grace window above exists to prevent.
 */
export const LIMIT_RESET_MAX_AHEAD_MS = 24 * 60 * 60_000;

/** Minutes in a day, for the wrap below. */
const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * 60_000;

/**
 * "resets 5:30pm (UTC)" as an instant, given when it was said.
 *
 * The message carries a time of day and no date, which is fine for a human
 * reading it at the moment it appears and useless to anything comparing it with
 * `Date.now()` an hour later. Resolving it needs a clock, and the clock belongs
 * here rather than in the parser: `parseResetTime` is pure and stays that way.
 *
 * The case to get right is the wrap. A session limit hit at 23:50 UTC that
 * resets at "2am (UTC)" resets tomorrow, not fourteen hours ago — and "fourteen
 * hours ago" is not a harmless error, it makes the marker expired on arrival and
 * the limit invisible. So the rule is the next occurrence: today's if it is
 * still ahead, tomorrow's otherwise.
 *
 * Equality counts as tomorrow. A limit announced at exactly the minute it
 * claims to reset has not reset — the message would not have been written if it
 * had — and the alternative reading produces a marker with a zero-length life.
 */
export function resolveResetAt(utcMinutes: number | null, atMs: number): number | null {
  if (utcMinutes === null || !Number.isFinite(utcMinutes)) return null;
  if (utcMinutes < 0 || utcMinutes >= DAY_MINUTES) return null;
  const at = new Date(atMs);
  const midnightUtc = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const today = midnightUtc + utcMinutes * 60_000;
  return today > atMs ? today : today + DAY_MS;
}

/** A number, or null — the column is JSONB and anything can be in it. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the marker out of whatever `sessions.metadata` holds.
 *
 * Tolerant of every shape for the reasons `readFoldMarker` lists: the column
 * defaults to `'{}'`, postgres.js has handed it back as a double-encoded string
 * before, and a row written by an older version of this code has no `limit` key.
 * None of those is a limit, and all of them must answer "no" rather than throw
 * inside a watchdog.
 *
 * A marker with no `startedAt` is not a marker. That field is what every
 * expiry decision below is measured from, and a marker without one would be
 * believed for ever.
 */
export function readLimitMarker(metadata: unknown): LimitMarker | null {
  let root: unknown = metadata;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      return null;
    }
  }
  if (!root || typeof root !== "object") return null;

  const raw = (root as Record<string, unknown>).limit;
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;

  const startedAt = numberOrNull(m.startedAt);
  if (startedAt === null) return null;

  return {
    kind: (typeof m.kind === "string" ? m.kind : "other") as ApiErrorKind,
    text: typeof m.text === "string" ? m.text : "",
    startedAt,
    resetsAt: numberOrNull(m.resetsAt),
    uuid: typeof m.uuid === "string" ? m.uuid : null,
  };
}

/**
 * Is this marker a limit that is still in force?
 *
 * Null once the stated reset time has passed, null once the grace window has
 * passed when no time was stated, and null for a start in the future — the host
 * and the container read the same machine's clock, but the value crosses a
 * process boundary as a number and a nonsensical one must not open an unbounded
 * window. Every branch here exists so that a marker cannot suppress hung-session
 * detection indefinitely; that is the whole of what this function is for.
 */
export function limitFromMarker(marker: LimitMarker | null, now: number): ActiveLimit | null {
  if (!marker) return null;
  const elapsedMs = now - marker.startedAt;
  if (elapsedMs < 0) return null;

  const stated = marker.resetsAt;
  const bounded =
    stated !== null && stated > marker.startedAt && stated - marker.startedAt <= LIMIT_RESET_MAX_AHEAD_MS
      ? stated
      : marker.startedAt + LIMIT_GRACE_DEFAULT_MS;

  if (now >= bounded) return null;
  return { ...marker, elapsedMs, expiresAt: bounded };
}

/**
 * The limit this session is under, or null.
 *
 * Asked by the supervisor's hung-session loop, and shaped after `sessionFold`
 * for the reason that one is shaped after `hasOpenQuestion`: three questions of
 * the form "is this silence explained", asked in the same place, answered the
 * same way. A database that will not answer is not a limit — failing closed here
 * would turn one bad query into a permanently mute watchdog.
 */
export async function sessionLimit(
  sql: postgres.Sql,
  sessionId: number,
  now: number = Date.now(),
): Promise<ActiveLimit | null> {
  const rows = await sql`
    SELECT metadata FROM sessions WHERE id = ${sessionId}
  `.catch(() => [] as unknown[]);
  const row = rows[0] as { metadata?: unknown } | undefined;
  if (!row) return null;
  return limitFromMarker(readLimitMarker(row.metadata), now);
}

/**
 * Write the limit down.
 *
 * Called from the channel, which is the only process that reads the transcript.
 * Fire-and-forget at the call site: a marker that failed to write costs one
 * alert that says "hung" where it should have said "limited", not a session.
 *
 * `startedAt` comes from the caller's `Date.now()` rather than from `now()` in
 * SQL, for `startFold`'s reason — both processes run on the same host, and
 * comparing two values produced by the same kind of clock is the only way the
 * arithmetic in `limitFromMarker` means anything.
 */
export async function startLimit(sql: postgres.Sql, sessionId: number, marker: LimitMarker): Promise<void> {
  await sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'limit',
      jsonb_build_object(
        'kind', ${marker.kind}::text,
        'text', ${marker.text}::text,
        'startedAt', ${marker.startedAt}::bigint,
        'resetsAt', ${marker.resetsAt}::bigint,
        'uuid', ${marker.uuid}::text
      )
    )
    WHERE id = ${sessionId}
  `;
}

/**
 * The limit is over: the session just answered.
 *
 * Raised in review, and the half that was missing. `fold-marker.ts` has an
 * `endFold` called the moment the `compact_boundary` record arrives; this had
 * only `startLimit`, so nothing but the marker's own expiry ever took it back —
 * and that expiry is the *stated* reset time, which is a claim about the account
 * and not about this session.
 *
 * The failure that closes: a weekly limit at 09:00 says `resets 2pm`. The
 * operator does the sensible thing and switches the project's provider, so the
 * session can answer again at 09:10 — and the marker, which knows nothing about
 * providers, holds the queue until 14:00 while the hung-session and stuck-queue
 * detectors stay muted. Five hours of messages sitting invisible with no second
 * alert, because the one alert this flow sends is sent once per event.
 *
 * The key is removed rather than emptied, unlike `endFold` — which keeps `fold`
 * alive to carry `lastDurationMs` into the next fold's grace window. A limit has
 * no equivalent to carry, and `limitedSessions` narrows on `metadata ? 'limit'`,
 * so removing the key also takes the session out of the supervisor's scan
 * instead of leaving it to be read and discarded once a minute for ever.
 *
 * The `-` operator touches that one key: a session folding and limited at once
 * keeps its fold, which is the property `startLimit` is built around too.
 */
export async function endLimit(sql: postgres.Sql, sessionId: number): Promise<void> {
  await sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) - 'limit'
    WHERE id = ${sessionId}
  `;
}

/**
 * How often the poller re-asks whether its session is under a limit.
 *
 * The poller's loop runs every couple of seconds and its whole job is to be
 * cheap, so asking the database on every pass would double its query count to
 * answer a question whose answer changes at most twice a day. Ten seconds is
 * the longest a message can be delivered into a session that has just hit a
 * limit — which costs one failed turn, the same one that happened before this
 * existed — and it is short enough that the hold is in place well before the
 * five-minute stuck-queue detector could have an opinion.
 *
 * Once a limit *is* found the interval stops mattering: the marker says when it
 * lifts, so the hold needs no further queries until then.
 */
export const LIMIT_HOLD_RECHECK_MS = 10_000;

/**
 * Whether this session's queued work is being held, and until when.
 *
 * The poller already defers delivery for a chat that is mid-turn — a list of
 * chats to skip, drained when the chat frees up — and a limited session joins
 * that on the same terms, except that it is the whole session rather than one
 * chat: the limit is on the account, so no chat of that session can be answered.
 *
 * Holding is the one part of this flow that can lose work, so the release is
 * deliberately not a second clock. It is the marker's own expiry, which
 * `limitFromMarker` bounds whether or not the stated reset time ever arrives. A
 * held message that is never released would be worse than one delivered into a
 * failing session, because the failure is at least visible.
 *
 * A class rather than a function because the answer has to be remembered: the
 * point of the recheck interval is that most passes cost nothing.
 */
export class LimitHold {
  private heldUntil: number | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;

  /** True while delivery must wait. Cheap on the passes that ask nothing. */
  async held(sql: postgres.Sql, sessionId: number, now: number = Date.now()): Promise<boolean> {
    if (this.heldUntil !== null) {
      if (now < this.heldUntil) return true;
      // The reset time arrived. Ask again rather than simply releasing: a
      // session can hit a second limit while waiting out the first, and
      // releasing into that would deliver a message straight into a failure.
      this.heldUntil = null;
      this.checkedAt = Number.NEGATIVE_INFINITY;
    }

    if (now - this.checkedAt < LIMIT_HOLD_RECHECK_MS) return false;
    this.checkedAt = now;

    // A database that will not answer is not a limit, for `sessionLimit`'s
    // reason turned around: failing closed here would stop delivering messages
    // on the strength of a query that never came back.
    const limit = await sessionLimit(sql, sessionId, now).catch(() => null);
    if (!limit) return false;
    this.heldUntil = limit.expiresAt;
    return true;
  }

  /** When the hold lifts, or null when nothing is held. For the log line. */
  get until(): number | null {
    return this.heldUntil;
  }
}

/** One active session carrying a limit marker, as the supervisor's scan returns it. */
export interface LimitedSession {
  sessionId: number;
  project: string;
  limit: ActiveLimit;
}

/**
 * Every active session currently under a limit.
 *
 * `metadata ? 'limit'` narrows in the database rather than here: the alternative
 * is reading every active session's metadata once a minute to find the nought or
 * one of them that has ever hit a limit. The key is removed by `endLimit` and by
 * remote registration, but neither is guaranteed to have run — a marker written
 * by a CLI that then died is nobody's to clear — so the marker's own expiry does
 * the rest of the filtering, in `limitFromMarker`.
 */
export async function limitedSessions(
  sql: postgres.Sql,
  now: number = Date.now(),
): Promise<LimitedSession[]> {
  const rows = await sql`
    SELECT s.id AS session_id, s.project, s.metadata
    FROM sessions s
    WHERE s.status = 'active' AND s.metadata ? 'limit'
  `.catch(() => [] as unknown[]);

  const out: LimitedSession[] = [];
  for (const row of rows as Array<{ session_id?: unknown; project?: unknown; metadata?: unknown }>) {
    const limit = limitFromMarker(readLimitMarker(row.metadata), now);
    if (!limit) continue;
    out.push({
      sessionId: Number(row.session_id),
      project: String(row.project ?? "unknown"),
      limit,
    });
  }
  return out;
}

/** `session-limit` → "лимит сессии", for the one line the operator reads. */
export function limitLabel(kind: ApiErrorKind): string {
  if (kind === "weekly-limit") return "недельный лимит";
  if (kind === "session-limit") return "лимит сессии";
  return kind;
}

/** `1750000000000` → `17:30 UTC`. The time the operator is waiting for. */
export function resetLabel(resetsAt: number | null): string {
  if (resetsAt === null) return "время сброса не указано";
  const at = new Date(resetsAt);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `до ${hh}:${mm} UTC`;
}

/**
 * What each session is doing, remembered between ticks.
 *
 * The supervisor speaks only when something is wrong, so a long piece of work is
 * indistinguishable from a stall until the five-minute alarm decides — and the
 * alarm's whole question is whether silence means trouble. This is the other
 * half: a line per working session saying what it has spent and how far it has
 * got, so that "still thinking" is visible as such before anything has to guess.
 *
 * ## Nothing here polls anything
 *
 * Every number arrives from a read that already happens. The context-pressure
 * loop tails each active session's transcript every two minutes to decide
 * whether to summarise; it now hands what it read to `observe` on the way past.
 * The session row it joins already carries the pane snapshot and the status
 * message. This module owns no timer, no file handle and no query.
 *
 * ## Two consumers, one state
 *
 * The pulse is one of them. The other is the hung-session loop, and it is the
 * reason `changedAt` is here rather than inside the renderer.
 *
 * `checkHungSessions` measures staleness from `active_status_messages.updated_at`,
 * which only exists while a Telegram turn is in flight. A session driven from
 * the tmux pane has no such row and no such clock, and the two obvious
 * substitutes are both traps:
 *
 *   - `sessions.last_active` is renewed unconditionally every sixty seconds by
 *     the channel's lease heartbeat (`channel/session.ts:renewLease`, called
 *     from `channel/index.ts`). It says the channel process is alive. It says
 *     nothing whatever about the session doing work, and a hang detector built
 *     on it would find nothing stale, ever, while appearing to work.
 *   - `sessions.pane_snapshot_at` is stamped by `scripts/tmux-watchdog.ts` on
 *     every poll of every active window, before any detector runs. Same shape of
 *     lie: it is the watcher's heartbeat, not the session's.
 *
 * `changedAt` is neither. It moves when the transcript's token counts move,
 * which happens only when the model produced something. That is the activity
 * signal, and it exists here because this is where the readings already are.
 */

import { escapeHtml } from "../utils/html.ts";
import { usageRatio } from "../utils/context-usage.ts";

/** One look at one session, as the context-pressure loop takes it. */
export interface PulseObservation {
  sessionId: number;
  project: string;
  /** Newest context total — input, cache read and cache write — or null. */
  inputTokens: number | null;
  /** Newest completed turn's output, or null. */
  outputTokens: number | null;
  /** The denominator, already resolved. */
  window: number;
  /** A Telegram turn is in flight: `active_status_messages` has a row. */
  busy: boolean;
  /** The pane snapshot is fresh and shows a turning spinner. */
  paneSpinner: boolean;
  /** When the current Telegram turn began, or null when there is none. */
  turnStartedAt: number | null;
  /** The newest line the transcript rendered — what the session is doing. */
  activity: string | null;
  /** The session is under an API limit, which is its own state and not this one. */
  limited: boolean;
  /** When this observation was taken. */
  at: number;
}

interface Tracked {
  last: PulseObservation;
  /** The last observation whose figures differed from the one before it. */
  changedAt: number;
  /** When this stretch of work began, for a session with no Telegram turn. */
  workingSince: number | null;
  /** The figures the previous pulse reported, or null when it reported none. */
  lastPulsed: string | null;
}

/** What a session is, as far as the pulse is concerned. */
export type PulseState = "working" | "stalled";

/** One rendered session, and the verdict behind it. */
export interface PulseLine {
  sessionId: number;
  project: string;
  state: PulseState;
  text: string;
}

/** The figures that have to move for a session to be thinking. */
function signature(o: PulseObservation): string {
  return `${o.inputTokens ?? "?"}|${o.outputTokens ?? "?"}`;
}

/** Working means a turn is in flight, by either of the two ways one can be. */
function isWorking(o: PulseObservation): boolean {
  return !o.limited && (o.busy || o.paneSpinner);
}

/** `611571` → `611.6k`, `1200000` → `1.2M`, `421` → `421`. */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** `260000` → `4m`, `20000` → `20s`, `7500000` → `2h 5m`. */
export function shortElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/**
 * The sessions the supervisor is watching, and what they were doing last time.
 *
 * A class rather than module-level maps for one reason: the supervisor already
 * has four of those and the test that resets them has to know all four by name.
 * One object with one `reset` is the shape that does not grow a fifth forgotten
 * map.
 */
export class SessionPulse {
  private readonly tracked = new Map<number, Tracked>();

  /** Record what one look at one session found. */
  observe(o: PulseObservation): void {
    const prev = this.tracked.get(o.sessionId);
    const moved = !prev || signature(prev.last) !== signature(o);
    const working = isWorking(o);
    this.tracked.set(o.sessionId, {
      last: o,
      changedAt: moved ? o.at : prev!.changedAt,
      workingSince: working ? (prev?.workingSince ?? o.at) : null,
      // A session that stops working forgets what it last reported, so that
      // coming back and reporting the same figures as an hour ago is not read
      // as two consecutive pulses. Two consecutive pulses means two in a row,
      // not two ever.
      lastPulsed: working ? (prev?.lastPulsed ?? null) : null,
    });
  }

  /**
   * When this session's figures last moved, or null when it has never been seen.
   *
   * Null, not `Date.now()`, and the difference is the whole point: a supervisor
   * that has just started has no evidence about any session, and "no evidence"
   * must not be answerable as "stale since the epoch". The hung-session loop
   * skips a session this cannot speak for.
   */
  activityAt(sessionId: number): number | null {
    return this.tracked.get(sessionId)?.changedAt ?? null;
  }

  /**
   * Take the pulse.
   *
   * Returns one line per working session and an empty array when there is
   * nothing to say — which is most of the time, and is the difference between a
   * monitoring feature and a notification the operator mutes. An idle session is
   * not here; nor is a limited one, which has its own report; nor is one whose
   * transcript has produced no numbers yet, because a line with nothing in it is
   * not worth a message.
   *
   * Mutating, and named for it: reporting a session's figures is what makes the
   * *next* identical reading the second of two consecutive ones. That comparison
   * is against the previous pulse rather than the previous observation on
   * purpose — the observations are two minutes apart and a session can
   * reasonably be quiet for two minutes; two pulses apart is a claim about a
   * much longer stretch.
   */
  pulse(now: number): PulseLine[] {
    const lines: PulseLine[] = [];

    for (const [sessionId, t] of this.tracked) {
      const o = t.last;
      if (!isWorking(o)) continue;
      if (o.inputTokens === null && o.outputTokens === null) continue;

      const sig = signature(o);
      const stalled = t.lastPulsed === sig;
      t.lastPulsed = sig;

      const elapsedFrom = o.turnStartedAt ?? t.workingSince;
      const parts: string[] = [];
      parts.push(
        `↑ ${o.inputTokens === null ? "?" : shortTokens(o.inputTokens)}` +
          ` ↓ ${o.outputTokens === null ? "?" : shortTokens(o.outputTokens)}`,
      );
      if (o.inputTokens !== null && o.window > 0) {
        parts.push(`${Math.round(usageRatio(o.inputTokens, o.window) * 100)}% от ${shortTokens(o.window)}`);
      }
      if (elapsedFrom !== null) parts.push(shortElapsed(now - elapsedFrom));
      if (stalled) parts.push(`цифры не менялись ${shortElapsed(now - t.changedAt)}`);
      if (o.activity) parts.push(escapeHtml(o.activity));

      lines.push({
        sessionId,
        project: o.project,
        state: stalled ? "stalled" : "working",
        // ⏸ rather than a second ⏳: a session whose numbers have not moved
        // between two pulses is neither hung — its status message is still
        // being written — nor limited, and calling it either would send the
        // operator to the wrong remedy. It is reported as what it is.
        text: `${stalled ? "⏸" : "⏳"} <b>${escapeHtml(o.project)}</b> — ${parts.join(" · ")}`,
      });
    }

    return lines;
  }

  /**
   * Forget sessions that are gone.
   *
   * The same hazard `contextHighWater` documents: a session id is a Postgres
   * serial that is reused once the old rows are reaped, and a map nothing prunes
   * would eventually hand a fresh session a stranger's `changedAt` — which the
   * hung-session loop would read as an hour of silence on a session one minute
   * old.
   */
  forget(seen: Set<number>): void {
    for (const id of this.tracked.keys()) if (!seen.has(id)) this.tracked.delete(id);
  }

  /** Exposed so a test can start from nothing; the loops never call it. */
  reset(): void {
    this.tracked.clear();
  }
}

/**
 * What the bot says about itself, and which of it is worth telling the operator.
 *
 * The supervisor's other nine checks read Docker, the queue, the sessions and
 * the status table. None of them reads `logs/bot.log`, and on 2026-08-05 three
 * separate repeating defects were live in one day of it: a voice pipeline
 * failing its first provider on every message, a fact extractor logging
 * `file not found` 4136 times, and the bot's own reactions logging as an access
 * violation. All three were found by a person reading the file while looking
 * for something else. A failure that logs and continues had been, to this
 * system, indistinguishable from success.
 *
 * Two rules decide what surfaces, because neither can see the other's case:
 *
 * - **Volume** — one message crossing a threshold inside a rolling window. This
 *   is the 4136 case: nothing new, everything wrong.
 * - **Novelty** — an error-level message not seen before, reported on its first
 *   occurrence whatever the count. This is the slow leak that never reaches a
 *   threshold, and it is what would have caught the Yandex 401 on the day it
 *   started rather than weeks later.
 *
 * Everything here is pure and takes its clock as an argument. The reading, the
 * alerting and the scheduling live in the supervisor.
 */

export interface LogEntry {
  /** pino level: 30 info, 40 warn, 50 error. */
  level: number;
  /** Epoch ms as pino writes it. */
  time: number;
  msg: string;
  /** One field of context, when the line carries something worth quoting. */
  detail?: string;
}

/** pino's level for an error, and for a warning. */
export const LEVEL_ERROR = 50;
export const LEVEL_WARN = 40;

/**
 * Fields worth quoting back to the operator, in order of preference.
 *
 * A bare message says something is failing; one of these usually says what.
 * Anything else in the line is left in the file — an alert that reproduces a
 * log line teaches the operator to skim alerts.
 */
const DETAIL_FIELDS = ["err", "error", "errorBody", "reason", "status", "transcriptPath", "project", "projectPath"] as const;

/**
 * One line into an entry, or null.
 *
 * Null is ordinary: the file is written by two processes, a read can catch a
 * half-written line, and pino is not the only thing that has ever appended to
 * a log file.
 */
export function parseLogEntry(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const level = typeof record.level === "number" ? record.level : NaN;
  const time = typeof record.time === "number" ? record.time : NaN;
  const msg = typeof record.msg === "string" ? record.msg.trim() : "";
  if (!Number.isFinite(level) || !Number.isFinite(time) || !msg) return null;

  let detail: string | undefined;
  for (const field of DETAIL_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text && text !== "{}") {
      detail = text.slice(0, 200);
      break;
    }
  }

  return { level, time, msg, ...(detail ? { detail } : {}) };
}

export interface StreamAlert {
  msg: string;
  level: number;
  /** Occurrences inside the window, including the one that triggered this. */
  count: number;
  /** When the oldest counted occurrence happened. */
  firstAt: number;
  windowMs: number;
  reason: "novel" | "volume";
  detail?: string;
}

export interface ErrorWindowOptions {
  /** How far back an occurrence still counts. */
  windowMs?: number;
  /** Occurrences of one error-level message before it is worth telling. */
  errorThreshold?: number;
  /** The same for warnings, which are noisier and less urgent. */
  warnThreshold?: number;
  /** How long a message stays "seen" for the novelty rule. */
  noveltyMs?: number;
}

export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_ERROR_THRESHOLD = 10;
/**
 * Warnings are two orders of magnitude noisier and rarely urgent, so the bar is
 * two orders of magnitude higher. 4136 in a day still clears it comfortably.
 */
export const DEFAULT_WARN_THRESHOLD = 200;
export const DEFAULT_NOVELTY_MS = 24 * 60 * 60 * 1000;

/**
 * A rolling window over one log stream.
 *
 * Held in memory and reset by a daemon restart, deliberately: an alert about
 * errors that stopped an hour ago is noise, and the file remains the record.
 */
export class ErrorWindow {
  private readonly windowMs: number;
  private readonly errorThreshold: number;
  private readonly warnThreshold: number;
  private readonly noveltyMs: number;

  /** Occurrence times per message, oldest first, trimmed to the window. */
  private readonly occurrences = new Map<string, number[]>();
  /** When each message was last seen at all — the novelty rule's memory. */
  private readonly lastSeen = new Map<string, number>();
  /** Messages already reported for volume, and when — one alert per window. */
  private readonly reportedAt = new Map<string, number>();

  constructor(options: ErrorWindowOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.errorThreshold = options.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
    this.warnThreshold = options.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
    this.noveltyMs = options.noveltyMs ?? DEFAULT_NOVELTY_MS;
  }

  /**
   * Fold in the lines read since the last pass and return what to say.
   *
   * `now` is the clock, passed rather than read, so a test can move time
   * without sleeping. Entries carry their own timestamps and are counted by
   * them; `now` decides only what has aged out.
   */
  observe(lines: readonly string[], now: number): StreamAlert[] {
    const alerts: StreamAlert[] = [];
    this.forget(now);

    for (const line of lines) {
      const entry = parseLogEntry(line);
      if (!entry || entry.level < LEVEL_WARN) continue;

      const seenBefore = this.lastSeen.get(entry.msg);
      const isNovel =
        entry.level >= LEVEL_ERROR &&
        (seenBefore === undefined || now - seenBefore > this.noveltyMs);
      this.lastSeen.set(entry.msg, entry.time);

      const times = this.occurrences.get(entry.msg) ?? [];
      times.push(entry.time);
      const cutoff = now - this.windowMs;
      const kept = times.filter((t) => t >= cutoff);
      // A line whose own timestamp is already outside the window — a batch read
      // after a long stall, or a clock that disagrees — still happened. Letting
      // it age itself out on arrival would report `count: 0`, which is not a
      // thing that can be true of an entry we are holding.
      if (kept.length === 0) kept.push(entry.time);
      this.occurrences.set(entry.msg, kept);

      if (isNovel) {
        // First sighting wins outright: a leak does not have to be loud.
        //
        // Deliberately not recorded as "reported": the two rules answer
        // different questions. Novelty says this error exists, volume says it
        // has become a flood, and an operator told about the first is still
        // owed the second. Only a volume alert suppresses further volume
        // alerts.
        alerts.push(this.alert(entry, kept, "novel"));
        continue;
      }

      const threshold = entry.level >= LEVEL_ERROR ? this.errorThreshold : this.warnThreshold;
      if (kept.length < threshold) continue;

      // One alert per message per window. Without this the 4136th warning is as
      // loud as the 200th, and the operator learns to ignore the topic.
      const reported = this.reportedAt.get(entry.msg);
      if (reported !== undefined && now - reported < this.windowMs) continue;

      alerts.push(this.alert(entry, kept, "volume"));
      this.reportedAt.set(entry.msg, now);
    }

    return alerts;
  }

  /**
   * Drop state for messages that have not been seen within the novelty memory.
   *
   * Raised in review as an unbounded leak. Measured before acting on it: the
   * whole history of `logs/bot.log` — 5149 warning and error lines — contains
   * **seven** distinct messages, because `msg` is a literal at every log call
   * in this repository and the key space is therefore the number of log
   * statements, not the amount of traffic. The predicted thousands of keys are
   * not what happens.
   *
   * It is still right to evict, for a reason the finding did not give: once a
   * message is older than `noveltyMs` it is novel again by definition, so
   * everything remembered about it is already unused. Keeping it is not a leak
   * so much as a lie about what the window knows. And should someone one day
   * interpolate a value into a `msg`, this makes the difference between a bug
   * and a slow one.
   */
  private forget(now: number): void {
    for (const [msg, seen] of this.lastSeen) {
      if (now - seen <= this.noveltyMs) continue;
      this.lastSeen.delete(msg);
      this.occurrences.delete(msg);
      this.reportedAt.delete(msg);
    }
  }

  private alert(entry: LogEntry, times: readonly number[], reason: "novel" | "volume"): StreamAlert {
    return {
      msg: entry.msg,
      level: entry.level,
      count: times.length,
      firstAt: times[0] ?? entry.time,
      windowMs: this.windowMs,
      reason,
      ...(entry.detail ? { detail: entry.detail } : {}),
    };
  }
}

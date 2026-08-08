/**
 * How full a session's context is, and whether that is worth acting on.
 *
 * ## Where the number comes from
 *
 * The transcript already records it. Every assistant entry carries
 * `message.usage`, and the context is the sum of three of its fields — what was
 * sent, what was read from cache, and what was written to it. Measured on this
 * repository's own session while this was written: 2 + 610 456 + 1 113 =
 * 611 571.
 *
 * The alternative was scraping the terminal, and it does not work. The `↓ N
 * tokens` the CLI prints is `output_tokens` for the current turn —
 * `utils/transcript-events.ts` says so where it reads it, and says the cache and
 * input counts are deliberately unused there. It is the wrong number, and the
 * pane it appears on is redrawn.
 *
 * ## Why the threshold is not 98%
 *
 * Three reasons, and the first is the one that matters. Summarising needs room:
 * the summariser reads the session's own messages and calls a model, and at 98%
 * there may be none left to do the work the trigger exists to cause. Second,
 * Claude Code folds on its own schedule, ahead of the hard limit, so a trigger
 * set above that point never fires at all. Third, the number lags — it is the
 * usage of the last completed message, and the next tool result can add tens of
 * thousands of tokens before anything measures again.
 */

import { parseEntry, type TranscriptEntry } from "./transcript-locate.ts";
import { outputTokens } from "./transcript-events.ts";

/**
 * The window assumed for a model nobody told us about.
 *
 * 200k is the current Claude window and the safe direction to be wrong in: too
 * small a denominator fires the threshold early, which costs one summary, while
 * too large never fires it at all, which costs the feature.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * The fraction at which a session is worth summarising, when nothing says
 * otherwise.
 *
 * One definition. `config.ts` validates the env override against it and the
 * supervisor reads it, because a default spelled out in both places is a
 * default that drifts.
 */
export const DEFAULT_CONTEXT_THRESHOLD = 0.85;

/** The range a threshold has to be in to mean anything. */
const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 0.99;

/**
 * Read the threshold from a raw env value.
 *
 * One definition because there are two readers, and they had disagreed:
 * `config.ts` validated the range and `scripts/supervisor.ts` clamped it. That
 * is not a stylistic difference — an out-of-range value took the bot container
 * down at startup while the supervisor quietly carried on at 0.5, so the same
 * typo produced an outage in one process and a shrug in the other.
 *
 * Clamping is the right half of that pair to keep: the value is an operator
 * preference, not a correctness invariant, and refusing to start over one
 * helps nobody.
 */
export function contextThreshold(raw: string | number | undefined | null): number {
  const parsed = typeof raw === "number" ? raw : Number.parseFloat((raw ?? "").toString().trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTEXT_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, parsed));
}

/**
 * Known windows, by the prefix of the model id.
 *
 * Prefixes rather than exact ids: model names carry a date suffix that changes
 * without the window changing with it, and a table keyed on the full id is a
 * table that silently falls back to the default every time a model is bumped.
 *
 * ★ Order is load-bearing, and it is the trap this table already fell into.
 * The scan takes the first prefix that matches, so a shorter prefix listed
 * above a longer one swallows it: `claude-opus-4` above `claude-opus-4-8` gave
 * a 1M-window model a 200k denominator. Longest prefix first, always, and the
 * test asserts the specific ids rather than the prefixes for that reason.
 *
 * Anthropic windows are from the Claude API model reference, not from memory —
 * the 4.x line is not uniform (Opus 4.6/4.7/4.8 and Sonnet 4.6 are 1M; Opus
 * 4.5/4.1 and Sonnet 4.5 are 200k), which is exactly how the wrong ones got
 * written down the first time.
 */
const WINDOWS: Array<[prefix: string, window: number]> = [
  // 1M-window Claude models. Every project in this deployment runs one of the
  // first two, so an omission here is not theoretical: it understates the
  // window fivefold and fires the trigger at a fifth of the real usage.
  ["claude-fable-5", 1_000_000],
  ["claude-mythos-5", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  // 200k Claude models. These must stay below their 1M siblings above.
  ["claude-opus-4-5", 200_000],
  ["claude-opus-4-1", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4-5", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude-3-5", 200_000],
  ["claude-3-7", 200_000],
  // Everything else the operator can register. A model absent here is not a
  // failure: it takes the documented default, `isKnownModel()` reports that it
  // did, and the loop logs the window it used.
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["o3", 200_000],
  ["gemini-1.5", 1_000_000],
  ["gemini-2", 1_000_000],
  ["qwen3", 40_960],
  ["deepseek", 128_000],
];

/** The context window for a model id, or the documented default. */
export function windowFor(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const id = model.toLowerCase();
  for (const [prefix, window] of WINDOWS) {
    if (id.startsWith(prefix)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * The prefixes, in scan order.
 *
 * Exported so the ordering rule above can be asserted rather than trusted: a
 * new entry placed above its own longer sibling silently gives that model the
 * wrong denominator, and a wrong denominator is a wrong percentage, not an
 * error anyone sees.
 */
export function knownModelPrefixes(): string[] {
  return WINDOWS.map(([prefix]) => prefix);
}

/** Whether a model id is one the table knows, as opposed to defaulted. */
export function isKnownModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  return WINDOWS.some(([prefix]) => id.startsWith(prefix));
}

/**
 * An entry the CLI manufactured rather than received.
 *
 * Claude Code writes its API errors into the transcript as assistant entries —
 * `isApiErrorMessage: true`, `model: "<synthetic>"` — and gives them a `usage`
 * block of zeros, because no call was made and there is nothing to report. That
 * block is indistinguishable from a real one to anything that only asks whether
 * `usage` is there.
 *
 * Which is a measurement bug, not a cosmetic one. `newestContextTokens` scans
 * backwards for the newest entry carrying usage, and a limit error is by
 * definition the newest entry in a session that just hit its limit: the
 * context-pressure loop would read that session as sitting at 0 tokens, release
 * its high-water mark and log `no-usage`/`below-threshold` for a window that is
 * in fact nearly full. The reading is not merely absent, it is confidently
 * wrong, which is the worse of the two.
 *
 * Recognised by the flag, for the reason `parseApiError` uses it: the model
 * string is corroboration and another program's to change.
 */
export function isSyntheticApiError(entry: TranscriptEntry | null | undefined): boolean {
  return (entry as Record<string, unknown> | null | undefined)?.isApiErrorMessage === true;
}

/**
 * The context this entry was answered with, or null.
 *
 * Null is an ordinary answer: a user entry, a tool result, a summary line —
 * most of a transcript carries no usage at all. Only an entry that records one
 * can say how full the window was, and the caller wants the newest such entry
 * rather than the newest entry.
 */
export function contextTokens(entry: TranscriptEntry | null | undefined): number | null {
  if (isSyntheticApiError(entry)) return null;
  const usage = entry?.message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const fields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  let total = 0;
  let seen = false;
  for (const field of fields) {
    const value = (usage as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * When Claude Code says this entry happened, in epoch milliseconds, or null.
 *
 * Every transcript line carries a `timestamp` written by the CLI at the moment
 * it appended the line. That is a different instant from when this process read
 * it, and the difference is the whole reason this exists: a transcript is a file
 * that can be re-read from the beginning — `TranscriptSession.reresolve` does
 * exactly that when it attaches to a new one — so "now" is a lie about any line
 * that is not brand new.
 */
export function entryTimestamp(entry: TranscriptEntry | null | undefined): number | null {
  const raw = entry?.timestamp;
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

/**
 * When the newest real answer in these lines was written, or null.
 *
 * "Real" is what `contextTokens` already means by returning a number: an entry
 * the model actually answered, carrying usage, and not one of the synthetic
 * error entries the CLI manufactures with a `usage` block of zeros. A session
 * that produced one of those is a session the API is talking to.
 *
 * Which is the evidence a limit is over. The marker cannot expire on its own
 * before its stated reset time, and that time is a claim about the account
 * rather than about this session — an operator who switches provider makes it
 * wrong by five hours. An answer makes it wrong observably, in the same file
 * the limit was read out of.
 *
 * Backwards, and one answer per batch rather than one per entry: the caller
 * turns this into a database write, and the newest is the only one that decides
 * anything.
 */
export function newestAnswerAt(lines: readonly string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseEntry(lines[i]!);
    if (contextTokens(entry) === null) continue;
    // An answer the CLI wrote without a timestamp cannot be placed in time, and
    // an unplaceable answer is not evidence about a marker written at a stated
    // instant. Skipped rather than dated to now, which would be the same guess
    // this function exists to stop making.
    const at = entryTimestamp(entry);
    if (at !== null) return at;
  }
  return null;
}

/**
 * The newest context measurement in these lines, or null.
 *
 * Scanned backwards, because the answer is the most recent one and most lines
 * do not carry it. Lines are the tail of the file, so the first one is usually
 * a fragment — `parseEntry` returns null for it and it is skipped, the same way
 * `/now` handles the same cut.
 */
export function newestContextTokens(lines: readonly string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const tokens = contextTokens(parseEntry(lines[i]!));
    if (tokens !== null) return tokens;
  }
  return null;
}

/**
 * What the newest completed turn produced, or null.
 *
 * The other half of the pair `newestContextTokens` gives: that one is what went
 * in, this one is what came back. Backwards for the same reason, and skipping
 * synthetic entries for the same reason — an error entry's `output_tokens: 0`
 * is not a turn that answered with nothing, it is a turn that never happened.
 */
export function newestOutputTokens(lines: readonly string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseEntry(lines[i]!);
    if (isSyntheticApiError(entry)) continue;
    const tokens = outputTokens(entry);
    if (tokens !== null) return tokens;
  }
  return null;
}

// ─── Asking Claude Code for the window instead of guessing it ────────────────

/**
 * What `/context` reported.
 *
 * The window table above exists only because we did not know the denominator.
 * Claude Code does: it gets the window from the API for whichever model and
 * provider the session actually runs on, and `/context` prints it. That output
 * is written into the transcript as an ordinary entry, so it is readable
 * without scraping a pane.
 */
export interface ContextReport {
  /** As Claude Code names it, suffix and all — `claude-opus-5[1m]`. */
  model: string;
  used: number;
  window: number;
}

/** `1m` → 1_000_000, `45.2k` → 45_200, `0` → 0. */
function parseTokenCount(raw: string): number | null {
  const m = /^([\d.,]+)\s*([km])?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]?.toLowerCase();
  return Math.round(n * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
}

/**
 * Read a `/context` report out of a transcript entry.
 *
 * The shape, verified against a real invocation rather than assumed:
 *
 *     ## Context Usage
 *
 *     **Model:** claude-opus-5[1m]
 *     **Tokens:** 0 / 1m (0%)
 *
 * Returns null for anything that is not one of these, because most transcript
 * entries are not, and a partial parse would be worse than none: this value
 * overrides the table, so a wrong read here is a wrong denominator everywhere.
 */
export function parseContextReport(content: unknown): ContextReport | null {
  if (typeof content !== "string" || !content.includes("Context Usage")) return null;

  const model = /\*\*Model:\*\*\s*(\S+)/.exec(content)?.[1];
  const tokens = /\*\*Tokens:\*\*\s*([\d.,]+\s*[km]?)\s*\/\s*([\d.,]+\s*[km]?)/i.exec(content);
  if (!model || !tokens) return null;

  const used = parseTokenCount(tokens[1]!);
  const window = parseTokenCount(tokens[2]!);
  // A zero window is not a window. Guarding here rather than at the call site
  // because a zero denominator would make `usageRatio` return 0 forever, which
  // reads as "there is plenty of room" rather than as a failure to measure.
  if (used === null || window === null || window <= 0) return null;

  return { model, used, window };
}

/**
 * The newest `/context` report in these lines, or null.
 *
 * Backwards for the same reason as `newestContextTokens`: the answer is the
 * most recent one, and most lines are not it.
 */
export function newestContextReport(lines: readonly string[]): ContextReport | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const report = parseContextReport((entry as { message?: { content?: unknown } })?.message?.content);
    if (report) return report;
  }
  return null;
}

/**
 * The window to divide by, best source first.
 *
 * A window Claude Code told us beats anything this file can infer — it is the
 * real number for the real model, including the providers the table will never
 * cover. The table is the fallback for a session that has not been asked yet,
 * and the default is the fallback for that.
 */
export function resolveWindow(learned: number | null | undefined, model: string | null | undefined): number {
  if (typeof learned === "number" && learned > 0) return learned;
  return windowFor(model);
}

/** How full, as a fraction. Clamped at 1 — a window can be exceeded on paper. */
export function usageRatio(contextTokens: number, window: number): number {
  if (!(window > 0)) return 0;
  return Math.min(1, contextTokens / window);
}

/** What the watcher decided, and enough of why to log it. */
export interface CrossingDecision {
  /** Summarise now. */
  summarize: boolean;
  /** The computed fraction, for the log line. */
  ratio: number;
  /** The denominator used, so a wrong one is visible rather than silent. */
  window: number;
  /** Why not, when not. */
  reason: "crossed" | "below-threshold" | "busy" | "already-summarized" | "no-usage";
}

export interface CrossingInput {
  /** Newest context measurement, or null when the transcript carries none yet. */
  contextTokens: number | null;
  /** The model this session runs on, for the window. */
  model: string | null | undefined;
  /**
   * A window Claude Code itself reported for this session, if it has been
   * asked. Beats the table: it is the real number for the real model, and it
   * covers the providers no table here will ever keep up with.
   */
  learnedWindow?: number | null;
  /** Fraction at or above which the session is worth summarising. */
  threshold: number;
  /** Whether the session is between turns. A busy session is left alone. */
  idle: boolean;
  /**
   * The highest ratio already summarised for this session, or 0.
   *
   * The gate that makes this once-per-crossing rather than once-per-tick. A
   * session sitting at 87% for an hour is one crossing, not one every tick;
   * only growth past the mark is a new one.
   */
  highWaterRatio: number;
}

/**
 * Whether this tick should summarise this session.
 *
 * Ordered so the log line says the most useful thing. "Busy" outranks
 * "below-threshold" only when the threshold is met — a session under the
 * threshold is under it whether or not it is working.
 */
export function decideCrossing(input: CrossingInput): CrossingDecision {
  const window = resolveWindow(input.learnedWindow, input.model);
  if (input.contextTokens === null) {
    return { summarize: false, ratio: 0, window, reason: "no-usage" };
  }
  const ratio = usageRatio(input.contextTokens, window);
  if (ratio < input.threshold) {
    return { summarize: false, ratio, window, reason: "below-threshold" };
  }
  if (ratio <= input.highWaterRatio) {
    return { summarize: false, ratio, window, reason: "already-summarized" };
  }
  if (!input.idle) {
    return { summarize: false, ratio, window, reason: "busy" };
  }
  return { summarize: true, ratio, window, reason: "crossed" };
}

/**
 * What Claude Code says about a fold it has just taken.
 *
 * Every field is nullable except the uuids that bound the surviving segment,
 * because this record is written by another program and its shape is that
 * program's to change. A future version that stops reporting `durationMs` has
 * not stopped folding, and a boundary we can only partly read is still a
 * boundary worth acting on.
 */
export interface CompactBoundary {
  /** "auto" when the window filled, "manual" when something typed `/compact`. */
  trigger: string | null;
  /** Context size before the fold, and after it. */
  preTokens: number | null;
  postTokens: number | null;
  /** What this fold dropped, and what every fold in this session has dropped. */
  droppedTokens: number | null;
  cumulativeDroppedTokens: number | null;
  /** How long the session was unresponsive. Two minutes, on both observed folds. */
  durationMs: number | null;
  /**
   * The bounds of what survived.
   *
   * `headUuid` is the load-bearing one: everything before it, back to the
   * previous boundary, is exactly what left the model's head — and is still in
   * the file. `tailUuid` identifies the boundary itself, which is what keeps a
   * fold from being captured twice.
   */
  headUuid: string | null;
  tailUuid: string | null;
}

/** A number, or null — never `NaN`, and never a string that happens to look numeric. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a `compact_boundary` record out of a parsed transcript entry.
 *
 * The shape, captured verbatim from this project's own transcript on
 * 2026-08-08 rather than assumed:
 *
 *     {"type":"system","subtype":"compact_boundary","content":"Conversation compacted",
 *      "compactMetadata":{"trigger":"auto","preTokens":999841,"postTokens":13608,
 *      "cumulativeDroppedTokens":986233,"durationMs":119544,
 *      "preservedSegment":{"headUuid":"…","anchorUuid":"…","tailUuid":"…"}, …}}
 *
 * Recognised by `type` and `subtype` and nothing else. Deliberately not by the
 * words in `content`: a session that discusses compaction — this repository does
 * it constantly — writes assistant entries full of the string "Conversation
 * compacted", and treating one of those as a fold would attribute a span to a
 * boundary that never happened.
 *
 * Returns null for everything that is not one, which is almost every line.
 */
export function parseCompactBoundary(entry: unknown): CompactBoundary | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== "system" || e.subtype !== "compact_boundary") return null;

  const meta = (e.compactMetadata && typeof e.compactMetadata === "object"
    ? (e.compactMetadata as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const segment = (meta.preservedSegment && typeof meta.preservedSegment === "object"
    ? (meta.preservedSegment as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const dropped = finiteOrNull(meta.cumulativeDroppedTokens);
  const pre = finiteOrNull(meta.preTokens);
  const post = finiteOrNull(meta.postTokens);

  return {
    trigger: typeof meta.trigger === "string" ? meta.trigger : null,
    preTokens: pre,
    postTokens: post,
    // What *this* fold dropped, which is not what the metadata reports.
    // `cumulativeDroppedTokens` is the running total across the session — 986233
    // on the first observed boundary and 1967705 on the second — so subtracting
    // is the only way to get the one number a reader actually wants. Derived
    // from pre and post when both are there, because that is this fold by
    // construction.
    // Never negative. A malformed boundary reporting post above pre would
    // otherwise be stored and shown as `dropped-tokens:-42`, which reads as a
    // bug in us rather than in what we were handed. Raised in review.
    droppedTokens: pre !== null && post !== null ? Math.max(0, pre - post) : null,
    cumulativeDroppedTokens: dropped,
    durationMs: finiteOrNull(meta.durationMs),
    headUuid: typeof segment.headUuid === "string" ? segment.headUuid : null,
    tailUuid: typeof segment.tailUuid === "string" ? segment.tailUuid : null,
  };
}

/**
 * Every boundary in these lines, oldest first.
 *
 * Plural and forward, unlike the `/context` readers above, and for the opposite
 * reason: those want the newest single answer, while a poll that catches two
 * folds owes the caller both. A long-lived session accumulates them — the
 * transcript read on 2026-08-08 had two.
 */
export function compactBoundaries(lines: readonly string[]): CompactBoundary[] {
  const out: CompactBoundary[] = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const boundary = parseCompactBoundary(entry);
    if (boundary) out.push(boundary);
  }
  return out;
}

/**
 * What Claude Code reports when a turn fails on the API rather than on the work.
 *
 * `kind` is a bucket, not the wording: the wording belongs to another program
 * and will change, so an unrecognised error becomes `"other"` and is still
 * reported. Losing an error because its phrasing moved is worse than reporting
 * one we cannot name.
 */
export type ApiErrorKind =
  | "session-limit"
  | "weekly-limit"
  | "overloaded"
  | "prompt-too-long"
  | "network"
  | "other";

export interface ApiError {
  kind: ApiErrorKind;
  /** The message as written, for the alert to quote rather than paraphrase. */
  text: string;
  /**
   * When the limit lifts, in UTC minutes since midnight, or null.
   *
   * Minutes rather than a Date because the message carries a time of day and no
   * date — "resets 5:30pm (UTC)" — and resolving that to an instant needs a
   * clock the parser does not have and should not invent. The caller knows when
   * it read the line; it can decide whether 5:30pm is later today or tomorrow.
   */
  resetsAtUtcMinutes: number | null;
}

/**
 * The reset time out of "· resets 5:30pm (UTC)" or "· resets 2pm (UTC)".
 *
 * Both forms are observed. Anything else — a timezone that is not UTC, a date,
 * a phrasing this has not met — returns null rather than a guess, because a
 * wrong reset time is worse than none: it is what decides when the limit marker
 * stops suppressing the hung-session alarm.
 */
export function parseResetTime(text: string): number | null {
  const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]!.toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/**
 * Read an API error out of a parsed transcript entry.
 *
 * Recognised by `isApiErrorMessage === true` and by nothing else. Not by the
 * words: this repository's sessions discuss rate limits, overload and prompt
 * length constantly, and matching prose would turn a conversation about the
 * problem into a report of the problem. The flag is Claude Code's own
 * statement that this entry is an error rather than an answer.
 *
 * Corroborating, and deliberately not required: these entries carry
 * `model: "<synthetic>"` and a `usage` block of zeros, because the CLI
 * manufactures them rather than receiving them. The zeros matter downstream —
 * anything totalling tokens must not read a synthetic entry as a turn that
 * used none.
 *
 * Texts observed in this project between 2026-07-07 and 2026-08-08:
 *
 *     You've hit your session limit · resets 5:30pm (UTC)
 *     You've hit your weekly limit · resets 2pm (UTC)
 *     API Error: 529 Overloaded. This is a server-side issue…
 *     Prompt is too long
 *     API Error: Unable to connect to API (ENOTFOUND)
 */
export function parseApiError(entry: unknown): ApiError | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.isApiErrorMessage !== true) return null;

  const content = (e.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((c): c is { text?: unknown } => Boolean(c) && typeof c === "object")
            .map((c) => (typeof c.text === "string" ? c.text : ""))
            .join(" ")
        : "";
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Weekly before session: the weekly message also contains the word "limit",
  // and it is the more consequential of the two — hours against days.
  const kind: ApiErrorKind = /weekly limit/i.test(trimmed)
    ? "weekly-limit"
    : /session limit|usage limit/i.test(trimmed)
      ? "session-limit"
      : /overloaded|\b529\b/i.test(trimmed)
        ? "overloaded"
        : /prompt is too long|too many tokens/i.test(trimmed)
          ? "prompt-too-long"
          : /unable to connect|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(trimmed)
            ? "network"
            : "other";

  return { kind, text: trimmed.slice(0, 500), resetsAtUtcMinutes: parseResetTime(trimmed) };
}

/** Whether this kind means "the account is out of allowance", not "the call failed". */
export function isLimitKind(kind: ApiErrorKind): boolean {
  return kind === "session-limit" || kind === "weekly-limit";
}

/**
 * An API error, plus the identity of the line it was written on.
 *
 * `uuid` is this flow's `tailUuid`. Flow 059 needed a name for one boundary so
 * that re-reading the file did not capture the same fold twice; the same
 * problem arrives here from two directions at once — the tail re-reads lines
 * after a re-resolve, and the supervisor re-reads the marker every sixty
 * seconds — and the answer is the same: every transcript entry carries a `uuid`
 * written by Claude Code, and two reads of one error agree on it while two
 * errors never do.
 *
 * Null when the entry has none. An error that cannot be named is still
 * reported; it just cannot be deduplicated, and the caller says what it does
 * about that rather than this pretending the case does not exist.
 */
export interface ApiErrorEvent extends ApiError {
  uuid: string | null;
}

/**
 * Every API error in these lines, oldest first.
 *
 * Plural and forward, for `compactBoundaries`' reason: a poll that catches two
 * errors owes the caller both. In practice they arrive one at a time — a limit
 * ends the turn — but a retried request that fails twice writes two lines, and
 * dropping either would mean the alert names the wrong one.
 */
export function apiErrors(lines: readonly string[]): ApiErrorEvent[] {
  const out: ApiErrorEvent[] = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const error = parseApiError(entry);
    if (!error) continue;
    const uuid = (entry as Record<string, unknown>).uuid;
    out.push({ ...error, uuid: typeof uuid === "string" && uuid ? uuid : null });
  }
  return out;
}

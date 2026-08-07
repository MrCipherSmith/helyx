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
 * The context this entry was answered with, or null.
 *
 * Null is an ordinary answer: a user entry, a tool result, a summary line —
 * most of a transcript carries no usage at all. Only an entry that records one
 * can say how full the window was, and the caller wants the newest such entry
 * rather than the newest entry.
 */
export function contextTokens(entry: TranscriptEntry | null | undefined): number | null {
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
  const window = windowFor(input.model);
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

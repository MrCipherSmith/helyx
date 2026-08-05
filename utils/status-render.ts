/**
 * The status message: what is happening now, and the numbers.
 *
 * Two parts, and they answer different questions. The first is the terminal —
 * the operator reads it to see what the session is actually doing, so nothing
 * should be dropped from it that could be shown. The second is the running
 * totals, which are glanceable rather than read.
 *
 * ## Why the work section is an expandable quote
 *
 * Telegram caps a message at 4096 characters, and a busy turn produces more
 * than that. The old rendering solved it by showing ten lines and hiding the
 * rest behind a spoiler, which reads as "there is more" and gives no sense of
 * how much. An expandable blockquote collapses to a few lines and opens to the
 * whole thing on a tap — everything is in the message, and the message stays
 * short until asked.
 *
 * ## Why the pane is `<pre>`
 *
 * The pane is terminal output: tree characters, aligned columns, diffs. In a
 * proportional font every one of those loses its alignment and a diff stops
 * looking like a diff. `<pre>` is the only Telegram tag that keeps it.
 */

import { escapeHtml } from "./html.ts";

/** Telegram's hard limit on a message. */
export const TELEGRAM_MAX_CHARS = 4096;

/**
 * How much of that the work section may take.
 *
 * The remainder is the header, the statistics and the tags themselves. Kept
 * well clear of the limit because a truncated message is not sent at all —
 * Telegram rejects it, and the operator sees nothing rather than something.
 */
export const WORK_BUDGET_CHARS = 3400;

/**
 * How long the header may be.
 *
 * The header is the elapsed time and the token count, which are a dozen
 * characters between them. It is bounded here rather than trusted because the
 * token count is scraped out of terminal output with a regex — `[\d.]+` will
 * match a thousand digits as happily as three — and it is added *outside* the
 * work budget, so an oversized one pushes the whole message past the limit no
 * matter how well the work half behaves.
 */
export const HEADER_BUDGET_CHARS = 64;

/** A spinner frame and a phase marker are one glyph each. */
export const GLYPH_BUDGET_CHARS = 8;

/**
 * Lines of recent activity to keep.
 *
 * Fifteen while the only source was a terminal scrape, where a whitelist threw
 * away everything that was not a tool call and fifteen lines was more than the
 * source could usually produce. The transcript reader produces the session's
 * actual reasoning and prose as well, so the cap was the binding constraint
 * rather than the safety margin it was meant to be.
 *
 * Raising it does not risk the message: `tailWithinBudget` below is what bounds
 * what is sent, and it is unchanged. This only decides how many lines are
 * offered to that budget.
 */
export const ACTIVITY_LINES = 40;
/** Lines of raw pane to show. */
export const PANE_LINES = 9;

export interface StatusParts {
  /** The activity lines, newest last. */
  stage: string;
  /** Elapsed time, already formatted. */
  elapsed: string;
  /** Token count, already formatted, including its separator. */
  tokens?: string;
  /** Raw terminal output. */
  pane?: string | null;
  spinner?: string;
  phaseEmoji?: string;
  toolCount?: number;
  fileCount?: number;
  /** What the operator asked, so the status says what it is working on. */
  question?: string | null;
}

/** A question longer than this is a paragraph, not a heading. */
const QUESTION_PREVIEW = 120;
/** And this is what it may cost once escaped — 120 ampersands are 600 characters. */
export const QUESTION_BUDGET_CHARS = 200;

/**
 * Cut escaped text to length without splitting an entity.
 *
 * The cut has to happen after escaping — see `escaped()` — and a slice through
 * `&amp;` leaves `&am`, which Telegram either renders as literal text or, worse,
 * reads as the start of an entity that swallows what follows.
 */
export function clampEscaped(html: string, max: number): string {
  if (max <= 0) return "";
  if (html.length <= max) return html;
  const cut = html.slice(0, Math.max(0, max - 1)).replace(/&[#a-zA-Z0-9]*$/, "");
  return `${cut}…`;
}

/**
 * Escape, and only then measure.
 *
 * Everything here is budgeted against its *escaped* length rather than its raw
 * one. `&` becomes `&amp;` and `<` becomes `&lt;`, so a line of ampersands is
 * five times longer once it reaches Telegram than it looks here — 3,400 of them
 * rendered as 17,010 characters against a 4,096 limit, and the message was
 * simply rejected. Terminal output is exactly where a run of ampersands comes
 * from.
 */
function escaped(text: string): string {
  return escapeHtml(text);
}

/**
 * Keep the last escaped lines that fit in `budget`.
 *
 * The *last*, deliberately. When there is more than fits, the useful end is the
 * recent one: the operator is watching what the session is doing now, and the
 * oldest line is the one they have already read.
 *
 * Lines must already be escaped: the budget is the length that will reach
 * Telegram, not the length before escaping inflates it.
 */
export function tailWithinBudget(lines: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const cost = line.length + 1;
    if (used + cost > budget) break;
    kept.unshift(line);
    used += cost;
  }
  // Never return nothing at all: one truncated line says more than an empty box.
  if (kept.length === 0 && lines.length > 0) {
    return [clampEscaped(lines[lines.length - 1]!, Math.max(0, budget))];
  }
  return kept;
}

/** The statistics line — the part read at a glance rather than followed. */
export function renderStats(parts: StatusParts): string {
  const bits: string[] = [];
  if (parts.tokens) {
    bits.push(clampEscaped(escaped(parts.tokens.replace(/^\s*·\s*/, "").trim()), HEADER_BUDGET_CHARS));
  }
  if ((parts.toolCount ?? 0) > 0) {
    // Ours, and numbers — nothing to escape.
    bits.push(`🔧 ${parts.toolCount} tools · ${parts.fileCount ?? 0} files`);
  }

  const question = parts.question?.trim();
  const lines: string[] = [];
  if (question) {
    // Twice over: `QUESTION_PREVIEW` is about what is readable at a glance and
    // is counted in the operator's characters, while `QUESTION_BUDGET_CHARS` is
    // about what fits in the message and is counted after escaping.
    const preview = question.slice(0, QUESTION_PREVIEW).replace(/\s+/g, " ");
    const marker = question.length > QUESTION_PREVIEW ? "…" : "";
    lines.push(`❓ <i>${clampEscaped(escaped(preview) + marker, QUESTION_BUDGET_CHARS)}</i>`);
  }
  if (bits.length > 0) lines.push(bits.join(" · "));

  return lines.join("\n");
}

/**
 * The whole status message.
 *
 * Assembled newest-first under a budget rather than truncated at a fixed line
 * count, because the two are not the same: forty short lines and eight long
 * ones cost the same message, and only one of those was previously allowed.
 */
export function renderStatus(parts: StatusParts): string {
  // Ours today — a spinner frame and a phase emoji, both constants. Bounded
  // anyway: the contract this module is meant to keep is that its output fits
  // and is well-formed, not that it fits as long as every caller behaves.
  const icon = clampEscaped(escaped(parts.spinner ?? ""), GLYPH_BUDGET_CHARS);
  const phaseIcon = clampEscaped(escaped(parts.phaseEmoji ?? ""), GLYPH_BUDGET_CHARS);
  const phase = phaseIcon ? ` ${phaseIcon}` : "";
  // Bounded and escaped: this is caller text, it carries the scraped token
  // count, and it sits outside the work budget.
  const elapsed = clampEscaped(escaped(parts.elapsed), HEADER_BUDGET_CHARS);
  const header = `${icon} <i>${elapsed}</i>${phase}`.trim();

  const stats = renderStats(parts);
  const statsBlock = stats ? `\n${stats}` : "";

  const paneRaw = parts.pane?.trim();
  const paneLines = paneRaw ? paneRaw.split("\n").slice(-PANE_LINES) : [];

  // The pane is charged against the budget first: it is the most recent thing
  // that happened, and the activity lines above it summarise what came before.
  let remaining = WORK_BUDGET_CHARS;
  let paneBlock = "";
  if (paneLines.length > 0) {
    const kept = tailWithinBudget(paneLines.map(escaped), Math.floor(WORK_BUDGET_CHARS / 2));
    const text = kept.join("\n");
    paneBlock = `\n<pre>${text}</pre>`;
    remaining -= text.length;
  }

  const activity = parts.stage.replace(/^⏳\s*/, "");
  if (!activity.includes("\n")) {
    // Budgeted too. A one-line stage comes from `update_status`, which takes
    // whatever the caller passes, and from the tmux spinner text, which is
    // whatever the terminal drew — neither is bounded, and a message over the
    // limit is rejected rather than trimmed.
    const single = tailWithinBudget([escaped(activity)], Math.max(0, remaining))[0] ?? "";
    const body = single.trim() ? `\n${single}` : "";
    return `${header}${body}${paneBlock}${statsBlock}`;
  }

  const lines = activity.split("\n").slice(-ACTIVITY_LINES);
  const kept = tailWithinBudget(lines.map(escaped), Math.max(0, remaining));
  // Expandable: the whole thing is in the message and the message stays short
  // until the operator asks for it.
  const work = `\n<blockquote expandable>${kept.join("\n")}</blockquote>`;

  return `${header}${work}${paneBlock}${statsBlock}`;
}

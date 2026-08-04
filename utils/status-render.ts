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

/** Lines of recent activity to keep. */
export const ACTIVITY_LINES = 15;
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

/**
 * Keep the last lines that fit in `budget`.
 *
 * The *last*, deliberately. When there is more than fits, the useful end is the
 * recent one: the operator is watching what the session is doing now, and the
 * oldest line is the one they have already read.
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
    return [lines[lines.length - 1]!.slice(0, Math.max(0, budget))];
  }
  return kept;
}

/** The statistics line — the part read at a glance rather than followed. */
export function renderStats(parts: StatusParts): string {
  const bits: string[] = [];
  if (parts.tokens) bits.push(parts.tokens.replace(/^\s*·\s*/, "").trim());
  if ((parts.toolCount ?? 0) > 0) {
    bits.push(`🔧 ${parts.toolCount} tools · ${parts.fileCount ?? 0} files`);
  }

  const question = parts.question?.trim();
  const lines: string[] = [];
  if (question) {
    const preview =
      question.length > QUESTION_PREVIEW ? `${question.slice(0, QUESTION_PREVIEW - 1)}…` : question;
    // The question is the operator's own words, so it is escaped like any other
    // text that is not ours.
    lines.push(`❓ <i>${escapeHtml(preview.replace(/\s+/g, " "))}</i>`);
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
  const icon = parts.spinner ?? "";
  const phase = parts.phaseEmoji ? ` ${parts.phaseEmoji}` : "";
  const header = `${icon} <i>${parts.elapsed}</i>${phase}`.trim();

  const stats = renderStats(parts);
  const statsBlock = stats ? `\n${stats}` : "";

  const paneRaw = parts.pane?.trim();
  const paneLines = paneRaw ? paneRaw.split("\n").slice(-PANE_LINES) : [];

  // The pane is charged against the budget first: it is the most recent thing
  // that happened, and the activity lines above it summarise what came before.
  let remaining = WORK_BUDGET_CHARS;
  let paneBlock = "";
  if (paneLines.length > 0) {
    const kept = tailWithinBudget(paneLines, Math.floor(WORK_BUDGET_CHARS / 2));
    const text = escapeHtml(kept.join("\n"));
    paneBlock = `\n<pre>${text}</pre>`;
    remaining -= text.length;
  }

  const activity = parts.stage.replace(/^⏳\s*/, "");
  if (!activity.includes("\n")) {
    const body = activity.trim() ? `\n${escapeHtml(activity)}` : "";
    return `${header}${body}${paneBlock}${statsBlock}`;
  }

  const lines = activity.split("\n").slice(-ACTIVITY_LINES);
  const kept = tailWithinBudget(lines, Math.max(0, remaining));
  // Expandable: the whole thing is in the message and the message stays short
  // until the operator asks for it.
  const work = `\n<blockquote expandable>${escapeHtml(kept.join("\n"))}</blockquote>`;

  return `${header}${work}${paneBlock}${statsBlock}`;
}

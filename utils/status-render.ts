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

/**
 * What the two glanceable lines above the work block may cost.
 *
 * Small on purpose. They are read at a glance, and anything that does not fit
 * in a phone's width is not glanceable however much of it survives.
 */
export const AGENTS_BUDGET_CHARS = 120;
export const SUMMARY_BUDGET_CHARS = 160;

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
  /**
   * Milliseconds since the session last did anything, or undefined when there
   * is no monitor to know.
   *
   * The one number that separates working from hung: the elapsed clock and the
   * spinner both keep moving for a turn that died three minutes ago.
   */
  idleMs?: number;
  /** Labels of the subagents currently running, newest last. */
  agents?: readonly string[];
  /** One line of what is happening now, above the work block. */
  summary?: string | null;
  /**
   * How long this session has been compacting its context, when it is.
   *
   * A fold answers nothing for the whole of its duration — 119544 ms and 149137
   * ms on the two observed in this project — and every other field here keeps
   * moving through it: the elapsed clock ticks, the spinner turns, and the work
   * block shows whatever the session did before it went quiet. Two minutes of
   * that is indistinguishable from a session that died, which is the report this
   * line exists to answer.
   */
  foldingMs?: number | null;
}

/**
 * The age of the last event, rounded to what the operator can act on.
 *
 * Rounded, not exact, and that is the whole point of the function. The text of
 * the status is hashed to suppress redundant edits; a field that changes every
 * tick would make that hash differ every tick and the message would be edited
 * once a second forever. Whole seconds under a minute, whole minutes above —
 * "3s" and "4m" answer the question, and between two rounding steps the dedup
 * still works.
 */
export function formatIdle(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

/** A line of activity that is a tool call rather than prose. */
const TOOL_LINE_RE = /^[●·⎿]\s*/;
/**
 * The prefix `markLines` puts in front of a subagent's output.
 *
 * Unbounded on purpose: `labelFor` caps a label derived from a description but
 * returns `agentType` at whatever length it is, so a long custom agent name
 * produces a prefix no bound here would match — and the line would be read as
 * prose and dropped from the summary. Raised in review.
 */
const AGENT_LABEL_RE = /^\[[^\]]+\]\s*/;

/**
 * One line of what the session is doing now, derived from what it just did.
 *
 * Derived rather than generated: this message is redrawn every few seconds, so
 * asking a model would cost tokens on every redraw and arrive after the answer
 * had changed. `/now` is where a model writes a summary, on request.
 *
 * The last tool call is the honest answer to "what is happening", and it is
 * already in hand. Prose lines are skipped — a paragraph of reasoning is not a
 * summary of itself — and null means the status renders without the line at
 * all rather than with an empty one.
 */
export function summarizeActivity(stage: string): string | null {
  const lines = stage.replace(/^⏳\s*/, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    // The marker may sit either side of the agent label: `markLines` puts the
    // label after the bullet for a bulleted line and in front of anything else.
    const withoutBullet = raw.replace(TOOL_LINE_RE, "");
    const cleaned = withoutBullet.replace(AGENT_LABEL_RE, "").trim();
    if (!cleaned) continue;
    if (!TOOL_LINE_RE.test(raw) && !AGENT_LABEL_RE.test(raw)) continue;
    return cleaned;
  }
  return null;
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
 * What a finished turn leaves in the chat.
 *
 * The closing edit used to replace the whole message with its summary line, so
 * the work block was not collapsed when the turn ended — it was overwritten.
 * There was nothing left to expand, which is exactly what an operator coming
 * back to the message an hour later wants to do.
 *
 * `summary` is already HTML — it is composed by the caller and carries `<code>`
 * around the diff counts — so it is passed through untouched. `stage` is the
 * last activity block, which came from a transcript or a terminal, and is
 * escaped here like every other line that reaches this module from outside.
 */
export function renderFinal(summary: string, stage?: string | null): string {
  const activity = (stage ?? "").replace(/^⏳\s*/, "").trim();
  if (!activity) return summary;

  // The summary is charged first: it is the line that must survive, and the
  // block below it is what gets shortened when there is no room.
  const budget = WORK_BUDGET_CHARS - summary.length;
  if (budget <= 0) return summary;

  const lines = activity.split("\n").slice(-ACTIVITY_LINES);
  const kept = tailWithinBudget(lines.map(escaped), budget).filter((line) => line.length > 0);
  if (kept.length === 0) return summary;

  return `${summary}\n<blockquote expandable>${kept.join("\n")}</blockquote>`;
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
  //
  // The idle age is appended before the clamp rather than after it, so the two
  // fields share one budget and the one that overflows it is the new one. A
  // header already at its limit keeps the elapsed clock it was carrying and
  // loses the age — clamping them separately would have let a scraped token
  // count push the header past a budget that exists to stop exactly that.
  const idle = parts.idleMs === undefined ? "" : ` · ⧗ ${formatIdle(parts.idleMs)}`;
  const elapsed = clampEscaped(`${escaped(parts.elapsed)}${idle}`, HEADER_BUDGET_CHARS);
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

  // Above the work block, and that is a requirement rather than a preference:
  // `tailWithinBudget` trims the quote from the front, so a line written into
  // it would be the first thing dropped on the busy turn that most needs it.
  let glance = "";
  // First of the glance lines, above the agents and the summary: while it is
  // showing, it is the only thing in the message that is true about now. The
  // duration is rounded by `formatIdle` for the reason that function exists —
  // the message text is hashed to suppress redundant edits, and a field that
  // changed every millisecond would defeat that hash for the whole fold.
  if (parts.foldingMs !== null && parts.foldingMs !== undefined) {
    const line = `🗜 сворачивает контекст · ${formatIdle(parts.foldingMs)}`;
    glance += `\n${line}`;
    remaining -= line.length;
  }
  const agents = (parts.agents ?? []).filter((label) => label.trim().length > 0);
  if (agents.length > 0) {
    const word = agents.length === 1 ? "агент" : "агента";
    const line = clampEscaped(escaped(`${agents.length} ${word}: ${agents.join(" · ")}`), AGENTS_BUDGET_CHARS);
    glance += `\n🧩 ${line}`;
    remaining -= line.length;
  }
  const summary = parts.summary?.trim();
  if (summary) {
    const line = clampEscaped(escaped(summary), SUMMARY_BUDGET_CHARS);
    glance += `\n▸ ${line}`;
    remaining -= line.length;
  }

  const activity = parts.stage.replace(/^⏳\s*/, "");
  if (!activity.includes("\n")) {
    // Budgeted too. A one-line stage comes from `update_status`, which takes
    // whatever the caller passes, and from the tmux spinner text, which is
    // whatever the terminal drew — neither is bounded, and a message over the
    // limit is rejected rather than trimmed.
    const single = tailWithinBudget([escaped(activity)], Math.max(0, remaining))[0] ?? "";
    const body = single.trim() ? `\n${single}` : "";
    return `${header}${glance}${body}${paneBlock}${statsBlock}`;
  }

  const lines = activity.split("\n").slice(-ACTIVITY_LINES);
  const kept = tailWithinBudget(lines.map(escaped), Math.max(0, remaining));
  // Expandable: the whole thing is in the message and the message stays short
  // until the operator asks for it.
  const work = `\n<blockquote expandable>${kept.join("\n")}</blockquote>`;

  return `${header}${glance}${work}${paneBlock}${statsBlock}`;
}

/**
 * A transcript entry as a line the operator reads.
 *
 * This is where the reasoning and the prose stop being thrown away.
 * `pane-parse.ts` returns null for anything that is not a tool call, a
 * sub-result or the spinner — which is most of what a session says — because a
 * terminal scrape has no way to tell prose from redraw noise. The transcript
 * does: every block is typed.
 *
 * ## The vocabulary is not a free choice
 *
 * Four things downstream read these lines by their shape, and none of them is in
 * this module:
 *
 *   channel/status.ts:accumulateTurnActivity  `● ` lines; `● Read|Write|Edit|Create: <path>`
 *   channel/status.ts:accumulateStats         `● Edit|Write: <path>`; "Added N lines, removed N lines"
 *   utils/status-format.ts:detectPhase        the last `● ` line picks the emoji
 *   utils/status-format.ts:scrapeTokenInfo    `↓ <n> tokens`
 *
 * So the lines here deliberately speak what `pane-parse.ts` already speaks. A
 * new dialect would not fail loudly; it would leave the tool counter at zero,
 * the file counter at zero, the phase emoji stuck on 🧠 and the token header
 * blank, all at once and all silently.
 */

import type { TranscriptEntry } from "./transcript-locate.ts";

/** A command, at the width `pane-parse.ts` uses for the same line. */
export const COMMAND_CHARS = 90;
/** A tool argument or a sub-result. */
export const ARG_CHARS = 75;
/** A result line. */
export const RESULT_CHARS = 83;
/**
 * A slice of what the model said or thought.
 *
 * Longer than the rest on purpose: this is the half of the status that did not
 * exist before, and a sentence cut to seventy-five characters is a fragment
 * rather than a thought. What actually bounds the message is
 * `tailWithinBudget`, which keeps the newest lines that fit.
 */
export const PROSE_CHARS = 200;

/** A subagent's line, marked as not the main thread. */
export const SIDECHAIN_PREFIX = "  │ ";

interface ContentBlock {
  type?: string;
  name?: string;
  text?: string;
  thinking?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
  tool_name?: string;
}

/** Whitespace collapsed and cut to `max`. Terminal text arrives with newlines in it. */
function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The last path segment, the way `pane-parse.ts` does it.
 *
 * A trailing slash makes `pop()` return the empty string, and the line then
 * reads `● Edit: · Added 3 lines` — a colon with nothing after it, and nothing
 * for the file-name patterns downstream to match. Raised in review; the
 * non-empty segment is the answer, and the whole path is the fallback.
 */
function baseName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) || path;
}

/**
 * The one interesting argument of a tool call.
 *
 * Ordered by how much it tells the operator: a path or a command says what is
 * being done, a pattern says what is being looked for, a description says what a
 * subagent was sent to do. Falling through to "the first string in the input" is
 * deliberate — an unknown tool still says something rather than nothing.
 */
export function toolArgument(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const key of ["file_path", "path", "command", "pattern", "query", "description", "url", "notebook_path"]) {
    const value = asString(input[key]);
    if (value) return value;
  }
  for (const value of Object.values(input)) {
    const str = asString(value);
    if (str) return str;
  }
  return null;
}

/** `mcp__helyx-channel__reply` → `reply`. */
function mcpToolName(name: string): string | null {
  const parts = name.split("__");
  return parts.length >= 3 ? parts[parts.length - 1]! : null;
}

/**
 * Lines in a block of text.
 *
 * A trailing newline terminates the last line rather than starting another —
 * `"a\n"` is one line. Raised in review: counting the pieces `split` returns
 * made every file that ends the way files do read as one line longer than it
 * is, and the closing summary's `+N` carried the error.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}

/**
 * What an edit changed, in the words `accumulateStats` already reads.
 *
 * `channel/status.ts:accumulateStats` sums "Added N lines, removed N lines" into
 * the `+N/-M` of the closing summary. On the terminal path that sentence came
 * from Claude Code's own rendering of the diff; the transcript carries no such
 * sentence, so without this the counter silently reads zero for every session
 * and the summary loses a number it used to have.
 *
 * The counts are of the blocks replaced, not of a line-level diff: an `Edit`
 * swaps `old_string` for `new_string` wholesale, so that is exactly what was
 * removed and exactly what was added. It can differ from what the terminal
 * showed, which computes a minimal diff — a one-character change inside a
 * ten-line block reads as ten and ten here, and as one and one there.
 */
function editCounts(name: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  if (name === "Edit") {
    const before = asString(input.old_string) ?? "";
    const after = asString(input.new_string) ?? "";
    if (!before && !after) return null;
    return `Added ${countLines(after)} lines, removed ${countLines(before)} lines`;
  }
  if (name === "Write") {
    const content = asString(input.content);
    if (content === null) return null;
    return `Added ${countLines(content)} lines, removed 0 lines`;
  }
  return null;
}

/** A tool call as its status line. */
export function renderToolUse(block: ContentBlock): string | null {
  const name = block.name;
  if (!name) return null;
  const arg = toolArgument(block.input);

  if (name === "Bash") {
    return arg ? `● $ ${preview(arg, COMMAND_CHARS)}` : "● $";
  }
  if (name === "Read" || name === "Write" || name === "Edit" || name === "NotebookEdit") {
    if (!arg) return `● ${name}`;
    // The counts ride on the same line rather than on one of their own, because
    // the file-name patterns downstream stop at the first whitespace and would
    // not survive a second `●` line for the same call.
    const counts = editCounts(name, block.input);
    const head = `● ${name}: ${preview(baseName(arg), ARG_CHARS)}`;
    return counts ? `${head} · ${counts}` : head;
  }
  if (name === "Task" || name === "Agent" || name === "Explore") {
    return arg ? `● Agent: ${preview(arg, ARG_CHARS)}` : "● Agent";
  }
  const mcp = name.startsWith("mcp__") ? mcpToolName(name) : null;
  if (mcp) return `● MCP: ${mcp}`;

  return arg ? `● ${name}: ${preview(arg, ARG_CHARS)}` : `● ${name}`;
}

/**
 * A tool result's text, whichever of the two shapes it arrived in.
 *
 * Both are real: a string for most tools, a list of blocks when the result
 * carries structure. Within the list, `text` blocks are the readable part and a
 * `tool_reference` names a tool rather than describing an outcome.
 */
export function resultText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const pieces: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as ContentBlock;
    const text = asString(block.text);
    if (text) pieces.push(text);
    else if (block.type === "tool_reference" && block.tool_name) pieces.push(block.tool_name);
  }
  const joined = pieces.join(" ").trim();
  return joined || null;
}

/** One content block as zero or one line. */
export function renderBlock(block: ContentBlock): string | null {
  switch (block.type) {
    case "tool_use":
      return renderToolUse(block);
    case "tool_result": {
      const text = resultText(block.content);
      if (!text) return null;
      const mark = block.is_error ? "❌ " : "";
      return `  └ ${mark}${preview(text, RESULT_CHARS)}`;
    }
    case "thinking": {
      const text = asString(block.thinking) ?? asString(block.text);
      return text ? `🧠 ${preview(text, PROSE_CHARS)}` : null;
    }
    case "text": {
      const text = asString(block.text);
      return text ? `💬 ${preview(text, PROSE_CHARS)}` : null;
    }
    default:
      return null;
  }
}

/**
 * Every line an entry produces, in order.
 *
 * An entry nobody recognises produces none, and that is the ordinary case rather
 * than an error: the transcript carries `attachment`, `mode`, `permission-mode`,
 * `last-prompt` and `queue-operation` entries that say nothing about what the
 * session is doing, and the format belongs to Claude Code, so more of them can
 * appear at any release. Silence is the only safe default.
 */
export function renderEntry(entry: TranscriptEntry | null): string[] {
  if (!entry) return [];
  if (entry.type !== "assistant" && entry.type !== "user") return [];

  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];

  const lines: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const line = renderBlock(item as ContentBlock);
    if (line) lines.push(entry.isSidechain ? `${SIDECHAIN_PREFIX}${line}` : line);
  }
  return lines;
}

/**
 * Output tokens reported by an entry, if it reports any.
 *
 * Only `output_tokens`: it is the number the CLI itself shows as `↓ N tokens`,
 * and the header exists to be comparable with what the operator sees in the
 * terminal. Cache and input counts are in the entry and deliberately unused.
 */
export function outputTokens(entry: TranscriptEntry | null): number | null {
  const usage = entry?.message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const value = (usage as Record<string, unknown>).output_tokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `3900` → `3.9k tokens`, in the shape `scrapeTokenInfo` reads back. */
export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}

/** The header line the token scraper and the operator both read. */
export function renderTokenLine(total: number): string {
  return `⏳ ↓ ${formatTokens(total)}`;
}

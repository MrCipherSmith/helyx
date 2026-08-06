/**
 * The message that says the turn is over.
 *
 * A session's final text never leaves the terminal. Only what it explicitly
 * sends through the `reply` tool reaches Telegram — so a turn that ends without
 * one delivers nothing at all, and the status message simply stops on whatever
 * line the terminal drew last. From the outside, finished and hung look
 * identical, and the operator is left asking "где конец, на чём остановился".
 *
 * So when the turn ends and nothing was sent, the bot sends the final assistant
 * message itself. Everything here is pure: it decides from parsed transcript
 * entries and returns text. Reading the file and sending the message belong to
 * the caller, which is what makes this reachable by a test at all — the
 * alternative is a fixture transcript on disk and a Telegram server.
 */

import { escapeHtml } from "./html.ts";
import { chunkMarkdown } from "./chunk.ts";
import { clampEscaped, TELEGRAM_MAX_CHARS } from "./status-render.ts";

/** One parsed JSONL line, narrowed to what this file reads. */
export interface TranscriptEntry {
  type?: string;
  message?: { content?: unknown };
}

/**
 * How much of the final message may be forwarded.
 *
 * Well under Telegram's limit: the marker, the tags and the escaping all have
 * to fit beside it, and a message over the limit is rejected rather than
 * trimmed — which would lose the very summary this exists to deliver.
 */
export const SUMMARY_BUDGET_CHARS = 3500;

/** Says the bot sent this, not the session. */
export const FORWARDED_MARKER = "📄 <i>итог хода</i>";

/** Parse JSONL, skipping what does not parse. */
export function parseTranscript(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // A transcript line is an object. A bare number or string parses fine and
      // would then be read for fields it cannot have.
      if (entry && typeof entry === "object" && !Array.isArray(entry)) out.push(entry);
    } catch {
      // A half-written last line is ordinary: the hook fires while the file is
      // still being appended to.
    }
  }
  return out;
}

const blocks = (entry: TranscriptEntry): Record<string, unknown>[] => {
  const content = entry.message?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
};

/**
 * Whether this entry is the operator speaking.
 *
 * Tool results arrive as `type: "user"` too — they are the transcript's way of
 * handing a result back to the model. Counting one as the operator would cut
 * the turn at the last tool call, and the summary would be whatever was said
 * before it rather than the conclusion.
 */
export function isOperatorMessage(entry: TranscriptEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  const parts = blocks(entry);
  return parts.length > 0 && !parts.some((b) => b.type === "tool_result");
}

/** The entries since the operator last spoke — the turn that just ended. */
export function lastTurn(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isOperatorMessage(entries[i]!)) return entries.slice(i + 1);
  }
  return [...entries];
}

/**
 * Whether the session already spoke to the operator during this turn.
 *
 * Matched by suffix because the tool is namespaced per server —
 * `mcp__helyx__reply` and `mcp__helyx-channel__reply` are both a reply, and
 * only one of them routes to the project topic. Both count as having spoken:
 * this decides whether to say something *again*, and saying it twice is its own
 * failure.
 */
export function repliedThisTurn(turn: readonly TranscriptEntry[]): boolean {
  return turn.some((entry) =>
    entry.type === "assistant" &&
    blocks(entry).some((b) => b.type === "tool_use" && typeof b.name === "string" && /(^|_)reply$/.test(b.name)),
  );
}

/** The last thing the session actually said, or nothing if it only used tools. */
export function finalAssistantText(turn: readonly TranscriptEntry[]): string | null {
  for (let i = turn.length - 1; i >= 0; i--) {
    const entry = turn[i]!;
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    // Thinking is not speech: it is the session's reasoning, and forwarding it
    // to the operator would publish something never addressed to them.
    const said = blocks(entry)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => (b.text as string).trim())
      .filter(Boolean)
      .join("\n\n");
    if (said) return said;
  }
  return null;
}

/** What the bot sends on the session's behalf, in the order it sends it. */
export interface TurnSummary {
  /** Ready-to-send HTML messages; the first carries the marker. */
  parts: string[];
  /** The same words unescaped, for the voice track that follows them. */
  spoken: string;
}

/** The message to send, or null when there is nothing to say. */
export function summaryFor(transcript: string): TurnSummary | null {
  const turn = lastTurn(parseTranscript(transcript));
  if (repliedThisTurn(turn)) return null;

  const said = finalAssistantText(turn);
  if (!said) return null;

  // Sent whole, across as many messages as it takes.
  //
  // It used to be one message clamped to 3500 characters, which is how a long
  // answer reached the operator as its first paragraph and an ellipsis — "часть
  // ответа". The reply path has carried long answers in pieces for as long as
  // it has existed; there was never a reason for the forwarded one not to,
  // beyond the assumption that a summary is short.
  const parts = chunkMarkdown(said, SUMMARY_BUDGET_CHARS).map((piece, i) =>
    i === 0 ? `${FORWARDED_MARKER}\n${escapeHtml(piece)}` : escapeHtml(piece),
  );
  if (!parts.length) return null;

  // Belt and braces: the budget leaves room for the marker and the escaping,
  // and an over-long message is rejected outright rather than trimmed.
  return {
    parts: parts.map((p) => (p.length < TELEGRAM_MAX_CHARS ? p : clampEscaped(p, TELEGRAM_MAX_CHARS - 1))),
    spoken: said,
  };
}

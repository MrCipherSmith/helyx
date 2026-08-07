/**
 * What a permission request looks like on the operator's phone.
 *
 * ## Why one message
 *
 * The prompt used to arrive as two: a preview carrying the file and the change,
 * then the question with the buttons. The operator read the change in one
 * message and answered it in another, and on a phone the two are often
 * separated by a scroll. They are one thought, so they are one message — and
 * Telegram is happy to put an inline keyboard on a message containing a `<pre>`
 * block, so nothing about the buttons had to change to allow it.
 *
 * The split survives as the fallback. A 1500-character diff plus a long path
 * can pass Telegram's 4096-character limit, and a message over the limit is not
 * truncated, it is refused — which would turn a cosmetic improvement into a
 * prompt that never arrives.
 *
 * ## Why the body is stored without its header
 *
 * The answer replaces the header and keeps everything under it: `🔐 Allow?`
 * becomes `✅ Allowed` or `❌ Denied`. Storing the body on its own makes that a
 * concatenation instead of a parse, and means the edit never has to read the
 * message back off Telegram — which is where the formatting used to be lost,
 * because `message.text` is the plain text with every entity stripped.
 */

import { escapeHtml } from "./html.ts";

/** Telegram refuses a message over this; it does not truncate one. */
export const TELEGRAM_MESSAGE_MAX = 4096;

/** The header the prompt is asked under. */
export const PROMPT_HEADER = "🔐 Allow?";

/**
 * The one definition of the three buttons.
 *
 * It used to be two — here and in the tmux watchdog — which is one more than
 * the number of places a change to them would have been remembered.
 */
export function permissionKeyboard(requestId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [[
      { text: "✅ Yes", callback_data: `perm:allow:${requestId}` },
      { text: "✅ Always", callback_data: `perm:always:${requestId}` },
      { text: "❌ No", callback_data: `perm:deny:${requestId}` },
    ]],
  };
}

/**
 * A path as the operator needs to read it: the last two segments.
 *
 * The prompt used to carry the absolute path while the preview message directly
 * above it carried these two, so the same file was named two ways in two
 * consecutive messages.
 *
 * Only ever called on something already known to be a path. Applied to
 * anything else it does not shorten, it hides: `$ rm -rf /var/log/app` comes
 * back as `log/app`, which is not a shorter way of saying the same thing, it is
 * a different thing, and it is the thing the operator is about to approve.
 */
export function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}

/**
 * The tools whose target is a filesystem path, and only those.
 *
 * `buildDetail` puts the whole tool input in the target slot for everything
 * else — the command line for Bash, the pattern for Grep, the JSON for an MCP
 * tool. None of those are paths, and shortening them removes exactly the part
 * the operator needs to see.
 */
const PATH_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit"]);

/**
 * How much of the target the head may carry.
 *
 * Bounded so the head alone always fits a Telegram message. A change block can
 * be split into a message of its own when it overflows; the head cannot,
 * because it is the message. A prompt is only ever refused for being too long
 * when nothing in it was clampable, and this makes that set empty.
 */
export const TARGET_BUDGET_CHARS = 1200;

export interface PromptParts {
  /** `Edit`, `Bash`, `Write`, … */
  toolName: string;
  /** First line of `descMain` is the tool name; the rest is the target. */
  descMain: string;
  /** Old/new lines, `-`/`+` prefixed. Not a unified diff — there are no line numbers. */
  change: string;
  /** Fence language. `diff` for edits, empty for anything else. */
  lang?: string;
}

/**
 * The body of the prompt: the tool line, and the change under it.
 *
 * Returned without the header so the same string can be reused verbatim when
 * the answer replaces that header.
 */
export function renderPromptBody(parts: PromptParts): string {
  const raw = targetOf(parts.descMain);
  const target = clamp(PATH_TOOLS.has(parts.toolName) ? shortPath(raw) : raw, TARGET_BUDGET_CHARS);
  const head = target
    ? `<b>${escapeHtml(parts.toolName)}</b> · <code>${escapeHtml(target)}</code>`
    : `<b>${escapeHtml(parts.toolName)}</b>`;
  if (!parts.change.trim()) return head;
  const lang = parts.lang ?? "";
  return `${head}\n<pre><code class="language-${lang}">${escapeHtml(parts.change)}</code></pre>`;
}

/**
 * Everything after the tool name in `descMain`.
 *
 * `buildDetail` composes it as `<tool>\n<target>`, where the target is a file
 * path for Edit/Write/Read, a `$ command` for Bash, and a description for
 * anything without a shape of its own. Only a path is worth shortening, so a
 * target that does not look like one is returned untouched by `shortPath`
 * anyway — it has no separators to cut on.
 */
function targetOf(descMain: string): string {
  const nl = descMain.indexOf("\n");
  return nl === -1 ? "" : descMain.slice(nl + 1).trim();
}

/** Cut to a budget, saying so when it cuts. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The full message, header included. */
export function renderPrompt(body: string): string {
  return `${PROMPT_HEADER}\n\n${body}`;
}

/**
 * Whether the single-message form is deliverable.
 *
 * Measured on the rendered HTML rather than the visible text: Telegram counts
 * the entities too, and an escaped diff is longer than the diff it came from.
 */
export function fitsOneMessage(body: string): boolean {
  return renderPrompt(body).length <= TELEGRAM_MESSAGE_MAX;
}

/** What the prompt becomes once it is answered. */
export type Outcome = "allow" | "always" | "deny" | "timeout" | "terminal";

/**
 * The answered message.
 *
 * The body is carried through untouched, so a fenced change is still fenced
 * after the tap. That is the whole point of storing it: the previous version
 * rebuilt this text from `ctx.callbackQuery.message.text`, which is the plain
 * text of the message, and sent it back with no `parse_mode` — so the change
 * survived the question and did not survive the answer.
 */
export function renderAnswered(outcome: Outcome, body: string, toolName?: string): string {
  const header =
    outcome === "allow" ? "✅ Allowed"
    : outcome === "always" ? `✅ Always allowed: ${escapeHtml(toolName ?? "")}`.trim()
    : outcome === "deny" ? "❌ Denied"
    : outcome === "timeout" ? "⏰ Timeout"
    : "⚡ Resolved in terminal";
  return `${header}\n\n${body}`;
}

/**
 * Clearing the keyboard has to be explicit.
 *
 * Telegram keeps the existing markup when `reply_markup` is omitted from an
 * edit — which the two-minute "still waiting" edit relies on, and which left
 * three live buttons under an already-answered request. An answered prompt
 * passes this instead.
 */
export const NO_KEYBOARD = { inline_keyboard: [] as Array<Array<never>> };

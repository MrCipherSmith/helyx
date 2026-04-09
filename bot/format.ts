import type { Context } from "grammy";

/**
 * Reply helper that automatically injects message_thread_id when the
 * incoming message is in a forum topic. Use everywhere instead of bare ctx.reply().
 */
export function replyInThread(
  ctx: Context,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<any> {
  const threadId = ctx.message?.message_thread_id;
  if (threadId) {
    return ctx.reply(text, { ...extra, message_thread_id: threadId } as any);
  }
  return ctx.reply(text, extra as any);
}

// Characters that must be escaped in MarkdownV2
const ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(ESCAPE_CHARS, "\\$1");
}

/**
 * Convert standard markdown to Telegram HTML.
 * Handles: bold, italic, code, code blocks, links, strikethrough, blockquotes.
 * Preserves existing HTML tags (pass-through).
 * Safe for Telegram's HTML parse_mode.
 */
export function markdownToTelegramHtml(text: string): string {
  // 1. Extract existing HTML tags and code blocks to protect them from escaping
  const placeholders: string[] = [];
  const ph = (s: string) => {
    placeholders.push(s);
    return `\x00PH${placeholders.length - 1}\x00`;
  };

  let result = text;

  // Protect existing HTML tags (pass-through)
  result = result.replace(/<(\/?)(\w+)([^>]*)>/g, (match) => ph(match));

  // Protect markdown code blocks before escaping
  // Supports: ```lang\ncode```, ```\ncode```, ```lang code``` (inline)
  result = result.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_, lang, code) => {
      const escaped = code.trim()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const cls = lang ? ` class="language-${lang}"` : "";
      return ph(`<pre><code${cls}>${escaped}</code></pre>`);
    },
  );

  // Protect inline code before escaping
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return ph(`<code>${escaped}</code>`);
  });

  // 2. Escape remaining HTML entities
  result = result
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 3. Convert markdown formatting

  // Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* → <i>text</i>
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Underline: __text__ → <u>text</u>
  result = result.replace(/__(.+?)__/g, "<u>$1</u>");

  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // Blockquotes: > text → <blockquote>text</blockquote>
  result = result.replace(
    /(?:^|\n)(?:&gt;|>) (.+?)(?=\n[^&>]|\n$|$)/gs,
    (match) => {
      const lines = match.trim().replace(/^(?:&gt;|>) ?/gm, "");
      return `\n<blockquote>${lines}</blockquote>`;
    },
  );

  // 4. Restore placeholders
  result = result.replace(/\x00PH(\d+)\x00/g, (_, i) => placeholders[Number(i)]);

  return result.trim();
}

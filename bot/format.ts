// Characters that must be escaped in MarkdownV2
const ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(ESCAPE_CHARS, "\\$1");
}

/**
 * Convert standard markdown to Telegram HTML.
 * Handles: bold, italic, code, code blocks, links, strikethrough.
 * Safe for Telegram's HTML parse_mode.
 */
export function markdownToTelegramHtml(text: string): string {
  // Escape HTML entities first
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks: ```lang\ncode\n``` → <pre><code class="language-lang">code</code></pre>
  result = result.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const cls = lang ? ` class="language-${lang}"` : "";
      return `<pre><code${cls}>${code.trimEnd()}</code></pre>`;
    },
  );

  // Inline code: `code` → <code>code</code>
  result = result.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* → <i>text</i> (but not inside <b> tags from bold)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  return result;
}

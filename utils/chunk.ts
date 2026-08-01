const MAX_LENGTH = 4096;

export function chunkText(text: string, maxLength = MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < maxLength * 0.3) {
      // Try line break
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // Try space
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // Hard cut
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Line index just past the last line that leaves the text well-formed.
 *
 * "Well-formed" means no fenced code block is left open and no table is cut
 * between its header and its rows. Telegram refuses to parse a message with an
 * unterminated fence, and the send falls back to HTML and then to plain text —
 * so a careless cut does not merely look wrong, it destroys the formatting of
 * everything in the chunk.
 */
function lastSafeLine(lines: string[], maxLines: number): number {
  let openFence = false;
  let lastSafe = 0;
  for (let i = 0; i < Math.min(maxLines, lines.length); i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) openFence = !openFence;
    if (openFence) continue;
    // A table row must not be the last kept line: the following rows would be
    // orphaned into the next chunk with no header above them.
    if (/^\s*\|/.test(line) && /^\s*\|/.test(lines[i + 1] ?? "")) continue;
    lastSafe = i + 1;
  }
  return lastSafe;
}

/**
 * Split markdown for Telegram without breaking its formatting.
 *
 * Cuts on line boundaries and never inside a fenced code block or a table.
 * A single block larger than the budget is emitted whole rather than cut in
 * half: an oversized message is Telegram's problem to reject, whereas a
 * bisected code fence silently degrades the entire chunk to plain text.
 */
export function chunkMarkdown(text: string, maxLength = MAX_LENGTH): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed ? [trimmed] : [];

  const chunks: string[] = [];
  let lines = trimmed.split("\n");

  while (lines.length) {
    // How many leading lines fit the budget (+1 per newline joined).
    let used = 0;
    let fits = 0;
    while (fits < lines.length) {
      const next = used + lines[fits]!.length + (fits > 0 ? 1 : 0);
      if (next > maxLength) break;
      used = next;
      fits++;
    }

    let take = fits === lines.length ? fits : lastSafeLine(lines, fits);
    // Nothing safe fits — the leading block is oversized. Emit it whole.
    if (take === 0) take = Math.max(1, blockEnd(lines));

    const piece = lines.slice(0, take).join("\n").trim();
    if (piece) chunks.push(piece);
    lines = lines.slice(take);
    while (lines.length && lines[0]!.trim() === "") lines.shift();
  }

  return chunks;
}

/** Length in lines of the leading block — a whole fenced section, or one line. */
function blockEnd(lines: string[]): number {
  if (!/^\s*```/.test(lines[0] ?? "")) return 1;
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) return i + 1;
  }
  return lines.length;
}

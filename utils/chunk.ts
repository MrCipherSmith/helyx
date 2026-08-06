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
 * Cuts on line boundaries and never inside a fenced code block or a table —
 * and never returns a chunk Telegram will refuse.
 *
 * That last clause used to read the other way round: an oversized block was
 * emitted whole, on the reasoning that "an oversized message is Telegram's
 * problem to reject". Telegram rejected it, `channel/tools.ts` bailed on the
 * failed send, and the whole reply was lost — a long answer with one big code
 * block reached the operator as nothing at all, while the session's own text
 * still showed in the status. Rejecting the message is not Telegram's problem
 * to have; it is the operator's silence.
 *
 * So an oversized fenced block is now carried across chunks with the fence
 * closed at the cut and re-opened, info string intact, on the next one. Each
 * piece parses on its own, and nothing is lost.
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

    const take = fits === lines.length ? fits : lastSafeLine(lines, fits);
    if (take === 0) {
      // Nothing safe fits — the leading block is bigger than one message.
      const { piece, rest } = splitOversized(lines, maxLength);
      if (piece) chunks.push(piece);
      lines = rest;
    } else {
      const piece = lines.slice(0, take).join("\n").trim();
      if (piece) chunks.push(piece);
      lines = lines.slice(take);
    }
    while (lines.length && lines[0]!.trim() === "") lines.shift();
  }

  return chunks;
}

/** Where a line may be cut so the cut does not land inside a word. */
function cutPoint(line: string, budget: number): number {
  const space = line.lastIndexOf(" ", budget);
  return space > budget * 0.5 ? space : budget;
}

/**
 * One message's worth of a block too big to fit in one, and what is left.
 *
 * Two shapes reach here. A fenced block keeps its fence: the piece opens with
 * the original fence line — info string and all, so the highlighting survives —
 * and closes with a bare one, and what remains re-opens the same way. A single
 * line with no fence around it has nowhere to break but inside itself, so it is
 * cut at the last space that fits.
 */
function splitOversized(lines: string[], maxLength: number): { piece: string; rest: string[] } {
  const open = lines[0] ?? "";
  const CLOSE = "```";

  if (!/^\s*```/.test(open)) {
    const cut = cutPoint(open, maxLength);
    return { piece: open.slice(0, cut).trim(), rest: [open.slice(cut).trimStart(), ...lines.slice(1)] };
  }

  // Room for the body once the two fence lines and their newlines are paid for.
  const budget = maxLength - open.length - CLOSE.length - 2;
  if (budget <= 0) {
    // A fence line longer than a whole message: nothing to preserve, cut it.
    const cut = cutPoint(open, maxLength);
    return { piece: open.slice(0, cut).trim(), rest: [open.slice(cut).trimStart(), ...lines.slice(1)] };
  }

  let used = 0;
  let taken = 0;
  while (1 + taken < lines.length) {
    const line = lines[1 + taken]!;
    // The block's own closing fence: everything before it fitted, so this is
    // the whole remainder and no re-open is needed.
    if (/^\s*```/.test(line)) break;
    const next = used + line.length + (taken > 0 ? 1 : 0);
    if (next > budget) break;
    used = next;
    taken++;
  }

  if (taken === 0) {
    // A single body line longer than one message — cut it inside the fence.
    const line = lines[1] ?? "";
    const cut = cutPoint(line, budget);
    return {
      piece: [open, line.slice(0, cut), CLOSE].join("\n"),
      rest: [open, line.slice(cut).trimStart(), ...lines.slice(2)],
    };
  }

  const body = lines.slice(1, 1 + taken);
  const remainder = lines.slice(1 + taken);
  // Nothing but the block's own closing fence left: it has been closed already.
  const rest =
    remainder.length && /^\s*```/.test(remainder[0]!)
      ? remainder.slice(1)
      : [open, ...remainder];

  return { piece: [open, ...body, CLOSE].join("\n"), rest };
}

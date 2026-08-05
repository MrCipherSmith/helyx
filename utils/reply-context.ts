/**
 * What the operator was pointing at.
 *
 * A reply carries half its meaning in the message it answers. "А тут как?" is
 * a complete question in Telegram and an empty one everywhere else, and until
 * this module existed everywhere else is where it arrived: the handlers read
 * `message.text` and nothing else, so the quote the operator had deliberately
 * selected was dropped on the way in. The session saw the question without its
 * subject and answered the wrong thing, or asked what was meant — which is the
 * one thing the operator had already said.
 *
 * Two Telegram fields carry it. `reply_to_message` is the whole message being
 * answered; `quote` is the fragment of it the operator dragged over, present
 * only when they selected one. The fragment wins when both exist: choosing a
 * few words out of a long message is an act of pointing, and re-quoting the
 * whole thing would bury what it pointed at.
 */

/** How much of the answered message is worth carrying. */
export const MAX_TEXT = 1200;
/** How much of a hand-selected fragment is worth carrying. */
export const MAX_QUOTE = 800;

export interface ReplyContext {
  /** Telegram id of the message being answered. */
  messageId?: number;
  /** Who wrote it, as it should read in a sentence. */
  author?: string;
  /** True when the answered message is one of ours. */
  fromBot?: boolean;
  /** Its text or caption, truncated. Absent when it carried neither. */
  text?: string;
  /** The fragment the operator selected, when they selected one. */
  quote?: string;
  /** What it was, when it carried no words: "photo", "voice", … */
  media?: string;
}

/** The shape this module needs, so tests do not have to build a grammY context. */
export interface ReplySource {
  message_id?: number;
  text?: string;
  caption?: string;
  from?: { first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
  sender_chat?: { title?: string };
  forum_topic_created?: unknown;
  photo?: unknown;
  voice?: unknown;
  video?: unknown;
  video_note?: unknown;
  audio?: unknown;
  animation?: unknown;
  sticker?: unknown;
  document?: unknown;
  poll?: unknown;
  location?: unknown;
}

export interface MessageWithReply {
  reply_to_message?: ReplySource;
  quote?: { text?: string };
  external_reply?: { message_id?: number };
}

const MEDIA_KINDS: ReadonlyArray<[keyof ReplySource, string]> = [
  ["photo", "photo"],
  ["voice", "voice message"],
  ["video_note", "video note"],
  ["video", "video"],
  ["audio", "audio"],
  ["animation", "animation"],
  ["sticker", "sticker"],
  ["document", "document"],
  ["poll", "poll"],
  ["location", "location"],
];

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * Who to name in the rendered block.
 *
 * `sender_chat` before `from`: a message posted as the group itself reports a
 * generic anonymous-admin user in `from`, and naming that instead of the group
 * would be worse than naming nobody.
 */
export function replyAuthor(source: ReplySource): string | undefined {
  const chatTitle = source.sender_chat?.title?.trim();
  if (chatTitle) return chatTitle;

  const from = source.from;
  if (!from) return undefined;

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  return from.username?.trim() || undefined;
}

/** What the answered message was, when it said nothing. */
export function replyMedia(source: ReplySource): string | undefined {
  for (const [field, label] of MEDIA_KINDS) {
    if (source[field]) return label;
  }
  return undefined;
}

/**
 * Read the reply out of an incoming message, or nothing when there is none.
 *
 * Returns `null` rather than an empty object so every caller can store the
 * result directly: a column that is either a reply or NULL reads the same way
 * in the database as it does here.
 */
export function extractReplyContext(message: MessageWithReply | undefined | null): ReplyContext | null {
  if (!message) return null;

  const source = message.reply_to_message;
  const quote = message.quote?.text?.trim();

  // The service message a forum topic opens with is attached as a reply to the
  // first message posted in the topic. It is Telegram's bookkeeping, not the
  // operator pointing at anything, and quoting "topic created" back at the
  // session would be noise on every new topic's first line.
  if (source?.forum_topic_created) return null;

  if (!source) {
    // A reply to a message in another chat arrives as `external_reply`, whose
    // body Telegram does not include. The selected fragment is all there is,
    // and it is still worth more than nothing.
    if (!quote) return null;
    const messageId = message.external_reply?.message_id;
    return { quote: truncate(quote, MAX_QUOTE), ...(messageId ? { messageId } : {}) };
  }

  const body = (source.text ?? source.caption ?? "").trim();
  const context: ReplyContext = {};

  if (source.message_id) context.messageId = source.message_id;

  const author = replyAuthor(source);
  if (author) context.author = author;
  if (source.from?.is_bot) context.fromBot = true;

  if (body) context.text = truncate(body, MAX_TEXT);
  else {
    const media = replyMedia(source);
    if (media) context.media = media;
  }

  if (quote) context.quote = truncate(quote, MAX_QUOTE);

  // A reply carrying no words, no media and no fragment says nothing worth a
  // block of its own — the message id alone tells the session nothing.
  if (!context.text && !context.quote && !context.media) return null;

  return context;
}

function blockquote(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

/**
 * Render the reply as a block to put in front of the operator's own words.
 *
 * Deliberately not merged into the message text at the point it is stored: the
 * status line, the short-term memory and the skill hints all read the stored
 * content, and a quote pasted into it would show up as the question being
 * worked on. The block is composed at delivery instead, next to the other
 * channel notes, where it belongs.
 */
export function renderReplyContext(context: ReplyContext | null | undefined): string {
  if (!context) return "";

  const who = context.author
    ? `${context.author}${context.fromBot ? " (this bot)" : ""}`
    : "someone";
  const which = context.messageId ? ` ${context.messageId}` : "";

  if (context.quote) {
    const head = `[Reply context: the user selected this fragment of ${who}'s message${which} and is replying to it]`;
    // Both the fragment and its surroundings, when the two differ — the
    // fragment says what was meant, the message says what it was taken from.
    const around = context.text && context.text !== context.quote
      ? `\n[The full message it was taken from]\n${blockquote(context.text)}`
      : "";
    return `${head}\n${blockquote(context.quote)}${around}\n`;
  }

  if (context.text) {
    return `[Reply context: the user is replying to ${who}'s message${which}]\n${blockquote(context.text)}\n`;
  }

  return `[Reply context: the user is replying to ${who}'s ${context.media}${which ? ` (message${which})` : ""}]\n`;
}

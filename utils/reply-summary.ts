import { callAuxLlm } from "./aux-llm-client.ts";
import { escapeHtml } from "./html.ts";
import { lastSentenceEnd } from "./tts.ts";
import { channelLogger } from "../logger.ts";

/**
 * Spoken recap of a reply.
 *
 * The full reply now reaches Telegram untouched — code fences, tables and links
 * included — which is exactly what a voice track cannot carry. Rather than
 * mangling the reply to make it speakable, the reply stays as written and this
 * produces a short recap to speak instead.
 */

/**
 * Below this much *prose* a recap is not worth speaking.
 *
 * The measure deliberately ignores code, tables and URLs: a reply that is one
 * line of text and forty lines of diff has nothing a voice track can carry, and
 * asking a model to narrate it produces filler at best.
 */
export const SUMMARY_MIN_CHARS = 200;

/** Telegram's hard cap on one message. */
const TELEGRAM_MESSAGE_MAX = 4096;

/**
 * What the caller puts in front of the recap text.
 *
 * Exported because the budget below is measured against the message as it will
 * actually be sent, and a reserve guessed in two places is a reserve that
 * drifts.
 */
export const RECAP_PREFIX = "🔊 ";

/** How much of a very long reply the model is asked to read. */
const INPUT_CAP = 12_000;

/**
 * The reply stripped of everything a voice track cannot read.
 *
 * Also the input to language detection — a diff carries no natural language, so
 * measuring it would let the model pick a language of its own. (It did: a pure
 * code reply came back summarised in Chinese, the aux model's native tongue.)
 */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced blocks
    .replace(/```[\s\S]*$/, " ") // an unterminated fence swallows the rest
    .replace(/`[^`\n]*`/g, " ") // inline code
    .replace(/^\s*\|.*$/gm, " ") // table rows
    .replace(/https?:\/\/\S+/g, " ") // bare URLs
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Language to speak in, named for the prompt.
 *
 * Script beats vocabulary here: Russian prose about code is full of Latin
 * identifiers, so a straight character count would call it English. Cyrillic
 * winning at all is enough to settle it.
 */
function speechLanguage(prose: string): string {
  return /[Ѐ-ӿ]/.test(prose) ? "Russian" : "English";
}

/** Replies with this much prose get a spoken recap. */
export function shouldSummarize(text: string): boolean {
  return proseOf(text).length >= SUMMARY_MIN_CHARS;
}

function summaryPrompt(language: string): string {
  return `You summarise a developer assistant's reply so it can be read aloud.

Rules:
- Two to eight sentences, in proportion to the reply: a short answer earns two,
  a long one may take eight. Say what was done, found or decided — the outcome,
  not the steps.
- CRITICAL: write the summary in ${language}, whatever language the reply is in.
  Use no other language, not even for a single word.
- Plain prose only: no markdown, no bullet points, no headings, no code.
- Never quote code, file paths, identifiers, URLs or command flags. Describe them
  in words instead ("the provider service", "the config file").
- Do not open with "The reply says" or similar — speak as the assistant.
- Output only the summary.`;
}

/**
 * Render a recap as a collapsed Telegram blockquote.
 *
 * The recap is an aside, not an answer. Without the quote bar it arrives as
 * another message in the same voice as the reply, and reads as if the assistant
 * said the same thing twice.
 *
 * `expandable` is what keeps it out of the way: the operator has just read the
 * reply this summarises, so at full height it only costs scrolling. Telegram
 * collapses it to a few lines behind a "show more" tail — how many lines is the
 * client's decision, not a value we can set.
 *
 * HTML rather than the rich-markdown path the reply itself takes: GFM has no
 * expandable-quote syntax, so this one message opts out of it. The summary
 * prompt forbids markdown, so escaping is all the text needs.
 */
export function asRecapQuote(text: string): string {
  return `<blockquote expandable>${escapeHtml(text.trim())}</blockquote>`;
}

/**
 * The recap, fitted to what one Telegram message can carry.
 *
 * Measured against the *rendered* message rather than the raw text: the quote
 * tags, the speaker glyph and whatever `escapeHtml` adds all come out of the
 * same 4096 characters, and a cap counted before escaping is a cap that does
 * not hold — one `&` becomes five characters.
 *
 * Nothing is cut while the recap fits, and it almost always does: the message
 * collapses, so length costs the operator nothing but the model's own restraint
 * bounds it long before Telegram does. When a cut is unavoidable it lands on a
 * sentence end, because a recap that stops mid-word reads as a session that
 * died rather than one that had more to say — which is exactly the confusion
 * the old `slice(0, 700)` produced.
 */
export function fitRecap(summary: string, budget = TELEGRAM_MESSAGE_MAX): string {
  const rendered = (t: string) => asRecapQuote(`${RECAP_PREFIX}${t}`).length;
  const text = summary.trim();
  if (rendered(text) <= budget) return text;

  // Walking sentence ends from the back rather than bisecting: a recap is a
  // handful of sentences, and the loop is over before a search would have set
  // up its bounds.
  let limit = text.length;
  while (limit > 0) {
    const end = lastSentenceEnd(text, limit);
    if (end <= 0) break;
    const candidate = text.slice(0, end).trim();
    if (rendered(candidate) <= budget) return candidate;
    limit = end - 1;
  }

  // No sentence boundary fits — one enormous sentence. Cut on a word and say so
  // with an ellipsis, so what the operator reads is "there was more" rather than
  // a thought that stopped.
  let cut = text.length;
  while (cut > 0 && rendered(`${text.slice(0, cut).trimEnd()}…`) > budget) {
    const space = text.lastIndexOf(" ", cut - 1);
    cut = space > 0 ? space : cut - 1;
  }
  return `${text.slice(0, cut).trimEnd()}…`;
}

/**
 * Summarise a reply for speech. Returns null when no summary is available —
 * the caller then sends no recap rather than speaking the raw reply, because
 * reading code fences aloud is what this whole change exists to stop.
 */
export async function summarizeForSpeech(text: string): Promise<string | null> {
  const language = speechLanguage(proseOf(text));
  const result = await callAuxLlm(
    summaryPrompt(language),
    text.slice(0, INPUT_CAP),
    "reply_voice_summary",
  );

  if ("error" in result) {
    channelLogger.warn({ err: result.error }, "reply summary failed");
    return null;
  }

  const summary = result.content.trim();
  if (summary.length < 20) {
    channelLogger.warn({ length: summary.length }, "reply summary too short to speak");
    return null;
  }
  channelLogger.info(
    { chars: summary.length, language, ms: result.durationMs, costUsd: result.costUsd },
    "reply summary ok",
  );
  return fitRecap(summary);
}

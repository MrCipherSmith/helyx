/**
 * What is worth remembering, and what is allowed to disappear.
 *
 * Two heuristics decide whether a conversation leaves any trace at all. They
 * ran inside `memory/summarizer.ts` where nothing could reach them, and they
 * are the most consequential unwatched code in the project: a wrong "yes, this
 * is trivial" drops a conversation without a summary, and nobody is told. The
 * fact is simply not there the next time someone looks for it, and the absence
 * is indistinguishable from never having discussed it.
 *
 * That asymmetry is why the thresholds are written down here rather than
 * inferred from the code that uses them. Keeping something worthless costs a
 * few tokens. Dropping something needed costs a fact nobody knows is missing.
 */

/** Below this average, a conversation reads as acknowledgements rather than content. */
export const TRIVIAL_AVG_LENGTH = 25;
/** A message this long is treated as carrying something. */
export const SUBSTANTIAL_LENGTH = 40;
/** How many substantial messages a conversation needs to be worth summarising. */
export const SUBSTANTIAL_REQUIRED = 2;
/** A summary shorter than this is not a summary. */
export const MIN_SUMMARY_LENGTH = 50;

/**
 * Whether this conversation is chit-chat.
 *
 * Three rules, and the first one is worth knowing about: **a conversation with
 * fewer than two user messages is always trivial.** A single long message —
 * "deploying needs the migration run first, and never with the cache warm" —
 * is discarded whole. That is the current behaviour, pinned here rather than
 * quietly changed: it is a real risk, and changing it is a decision about how
 * much noise the memory should carry, not a bug fix to slip into a test pass.
 */
export function isContentTrivial(messages: readonly { role: string; content: string }[]): boolean {
  const userMsgs = messages.filter((m) => m.role === "user");
  if (userMsgs.length < 2) return true;

  const avgLen = userMsgs.reduce((sum, m) => sum + m.content.trim().length, 0) / userMsgs.length;
  if (avgLen < TRIVIAL_AVG_LENGTH) return true;

  const substantial = userMsgs.filter((m) => m.content.trim().length >= SUBSTANTIAL_LENGTH);
  return substantial.length < SUBSTANTIAL_REQUIRED;
}

/**
 * The shapes a model produces when it has nothing to say.
 *
 * Matched at the start or anywhere, deliberately differently. A summary
 * *beginning* with "ok" is an acknowledgement; a summary *containing*
 * "nothing significant" is a model reporting emptiness in the middle of a
 * polite paragraph, and both are worth refusing.
 */
const EMPTY_SUMMARY_PATTERNS: readonly RegExp[] = [
  /^(ok|yes|no|sure|thanks|hello|hi|bye)/i,
  /nothing (significant|important|notable|relevant|useful)/i,
  /casual conversation/i,
  /no (tasks?|work|code|changes|questions)/i,
];

/**
 * Whether a produced summary is worth storing.
 *
 * The cost here is the opposite way round from `isContentTrivial`: a bad
 * summary saved is a wrong fact that will be recalled with confidence, which is
 * worse than no fact at all. So this one is allowed to be strict.
 */
export function isSummaryWorthSaving(summary: string): boolean {
  const trimmed = summary?.trim() ?? "";
  if (trimmed.length < MIN_SUMMARY_LENGTH) return false;
  return !EMPTY_SUMMARY_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * The key a session's idle timer is stored under.
 *
 * Session and chat together: one session serves several chats, and a timer
 * keyed by session alone would let the last chat to speak cancel every other
 * chat's pending summary.
 */
export function timerKey(sessionId: number, chatId: string): string {
  return `${sessionId}:${chatId}`;
}

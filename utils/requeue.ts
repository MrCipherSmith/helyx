/**
 * Questions put back on the queue after a turn ended without an answer.
 *
 * Two independent paths do this. The channel's response guard re-queues the
 * moment it declares a session stuck, because it is the one thing that knows,
 * right then, that this chat asked something and got nothing. The supervisor's
 * unanswered-message loop sweeps up whatever the guard could not see — a
 * channel process that died with the session, say — some minutes later.
 *
 * They have to recognise each other's work. A question that keeps going
 * unanswered would otherwise be re-queued by one path, fail again, and be
 * re-queued by the other, forever. One shared mark ends that: a question is
 * retried once, and a retry that also goes unanswered is left alone.
 */

/** Opens every re-queued question, whichever path queued it. */
const MARKER = "♻️";

/** Prefix `content` with the re-queue mark and a note for whoever reads it next. */
export function markRequeued(content: string, note: string): string {
  return `[${MARKER} ${note}]\n${content}`;
}

/** Whether this content has already had its retry. */
export function isRequeued(content: string): boolean {
  return content.trimStart().startsWith(`[${MARKER}`);
}

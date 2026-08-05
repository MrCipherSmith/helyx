/**
 * Whether the status message should still be there.
 *
 * It used to be deleted the moment a reply was sent, and a reply is very often
 * not the end of the work — "запускаю сабагентов", "собираю ветку", "жду CI".
 * From that moment the operator saw nothing, however long the turn ran.
 *
 * There was code meant to catch this. `channel/tools.ts` carried a comment
 * promising that `schedulePostReplyCheck` would notice post-reply activity and
 * open a continuation; nothing ever called it. Its whole idea — check once,
 * twenty seconds late, and decide from one timestamp — is replaced by three
 * questions asked here, each of them about elapsed time and nothing else, so a
 * test can step them instead of waiting them out.
 *
 * Nothing in this module touches Telegram, the database or a timer. It says
 * what should happen; `channel/status.ts` does it.
 */

/** How long a session may be silent before the turn is considered over. */
export const CONTINUATION_IDLE_MS = 45_000;

/**
 * How long after a reply activity still counts as the same turn continuing.
 *
 * Not the same question as the idle window. This one guards against a stale
 * timestamp from *before* the reply re-opening a status for work that has
 * already been reported — the trap the dead `schedulePostReplyCheck` avoided
 * by comparing against the moment of the reply, which is the one part of it
 * worth keeping.
 */
export const POST_REPLY_GRACE_MS = 2_000;

/** What the status manager knows when it asks. */
export interface ContinuationFacts {
  /** Is a status message open for this chat? */
  statusOpen: boolean;
  /** When the last reply was sent, or null if none in this turn. */
  repliedAt: number | null;
  /** When the monitor last reported anything, or null if it never has. */
  lastActivityAt: number | null;
  /** Does the operator have messages waiting to be delivered? */
  pendingUserMessages: boolean;
  /** Now. */
  now: number;
}

/**
 * Should a status be opened for work that is still going on?
 *
 * Three things must hold, and each of them has cost something in the past:
 *
 * - **No status is open.** Two statuses in one chat is the failure the early
 *   return in `updateStatus` was written to prevent, and it stays prevented.
 * - **The activity is the session's, after the reply.** Activity from before
 *   the reply belongs to the step that was just reported.
 * - **The operator is not waiting.** If messages are queued, the poller is
 *   about to open a status for the next turn; opening one here would make the
 *   chat look busy and hold the operator's own message behind it.
 */
export function shouldReopen(facts: ContinuationFacts): boolean {
  if (facts.statusOpen) return false;
  if (facts.pendingUserMessages) return false;
  if (facts.lastActivityAt === null) return false;
  if (facts.repliedAt === null) return false;
  return facts.lastActivityAt >= facts.repliedAt - POST_REPLY_GRACE_MS;
}

/**
 * Has the session been quiet long enough to call the turn finished?
 *
 * The only thing that ends a continuation. A status whose closing depended on
 * a reply would never close at all, since the reply is what started it.
 */
export function shouldClose(
  facts: Pick<ContinuationFacts, "lastActivityAt" | "now">,
  idleMs: number = CONTINUATION_IDLE_MS,
): boolean {
  if (facts.lastActivityAt === null) return false;
  return facts.now - facts.lastActivityAt >= idleMs;
}

/** What has landed in the topic since the status message was sent. */
export interface MoveFacts {
  /** Telegram message id of the status message. */
  statusMessageId: number;
  /**
   * The newest message id seen in this topic that is not the status itself —
   * a reply the session sent, or a message the operator's poller delivered.
   */
  lastOtherMessageId: number | null;
  /** Message id the status was last moved for, so one event moves it once. */
  movedFor: number | null;
}

/**
 * Should the status message be re-sent at the bottom of the topic?
 *
 * It is pinned, so it is always findable; but a status created before three
 * replies sits above all of them and is off the screen. It moves when
 * something else has landed after it — and only once per such thing.
 *
 * Bound to the event and never to the edit: edits run every few seconds, and a
 * move is a delete plus a send. Moving on each would be a blizzard in the
 * topic and a rate limit in the face.
 */
export function shouldMove(facts: MoveFacts): boolean {
  if (facts.lastOtherMessageId === null) return false;
  if (facts.lastOtherMessageId <= facts.statusMessageId) return false;
  return facts.movedFor === null || facts.lastOtherMessageId > facts.movedFor;
}

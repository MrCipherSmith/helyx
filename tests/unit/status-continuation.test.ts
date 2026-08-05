/**
 * Whether the status should still be there.
 *
 * The operator's report: an agent replies "запускаю сабагентов" and the topic
 * goes silent for minutes while it works. The status message was deleted by
 * the reply, and the code that was supposed to bring it back —
 * `schedulePostReplyCheck` — was never called by anything. Its only trace in
 * the repository was a comment promising it would run.
 *
 * These are the three decisions that replace it, each one about elapsed time
 * and nothing else, which is why they can be stepped here rather than waited
 * out: forty-five seconds is not a test.
 */

import { describe, test, expect } from "bun:test";
import {
  shouldReopen,
  shouldClose,
  shouldMove,
  CONTINUATION_IDLE_MS,
  POST_REPLY_GRACE_MS,
  type ContinuationFacts,
} from "../../utils/status-continuation.ts";

const NOW = 1_800_000_000_000;

function facts(over: Partial<ContinuationFacts> = {}): ContinuationFacts {
  return {
    statusOpen: false,
    repliedAt: NOW - 5_000,
    lastActivityAt: NOW - 1_000,
    pendingUserMessages: false,
    now: NOW,
    ...over,
  };
}

describe("re-opening a status for work that did not stop at the reply", () => {
  test("activity after the reply re-opens it", () => {
    // The reported case: the reply said what was starting, and the starting is
    // what the operator wanted to watch.
    expect(shouldReopen(facts())).toBe(true);
  });

  test("activity from before the reply does not", () => {
    // It belongs to the step that was just reported. Re-opening on it would
    // put a status up for work already described.
    expect(shouldReopen(facts({ lastActivityAt: NOW - 30_000, repliedAt: NOW - 5_000 }))).toBe(false);
  });

  test("activity a hair before the reply still counts", () => {
    // A line written while the reply was in flight is the same turn. The grace
    // is why the comparison is not a bare `>`.
    expect(shouldReopen(facts({
      repliedAt: NOW - 5_000,
      lastActivityAt: NOW - 5_000 - (POST_REPLY_GRACE_MS - 1),
    }))).toBe(true);
  });

  test("an open status is never doubled", () => {
    // Two statuses in one chat is what the early return in `updateStatus` was
    // written to prevent, and it stays prevented.
    expect(shouldReopen(facts({ statusOpen: true }))).toBe(false);
  });

  test("a waiting operator is not made to wait longer", () => {
    // The poller holds a user's message back while a chat has a status. If a
    // message is already queued, the poller is about to open a status for the
    // next turn — opening one here would hold the operator's own message
    // behind the tail of the last turn.
    expect(shouldReopen(facts({ pendingUserMessages: true }))).toBe(false);
  });

  test("a turn with no reply yet is the poller's business, not this one", () => {
    expect(shouldReopen(facts({ repliedAt: null }))).toBe(false);
  });

  test("a session that has never reported anything is not working", () => {
    expect(shouldReopen(facts({ lastActivityAt: null }))).toBe(false);
  });
});

describe("closing on silence", () => {
  test("a session quiet for the whole window is finished", () => {
    expect(shouldClose({ lastActivityAt: NOW - CONTINUATION_IDLE_MS, now: NOW })).toBe(true);
  });

  test("a session quiet for a moment is not", () => {
    expect(shouldClose({ lastActivityAt: NOW - (CONTINUATION_IDLE_MS - 1), now: NOW })).toBe(false);
  });

  test("silence is the only thing that closes it", () => {
    // Deliberate: a status that closed on a reply would never survive one, and
    // surviving the reply is the whole point.
    expect(shouldClose({ lastActivityAt: NOW, now: NOW })).toBe(false);
  });

  test("a status that has seen nothing at all is left to the guard", () => {
    // Not this decision's business: a status with no activity ever is what the
    // response guard exists for, and closing it here would race that.
    expect(shouldClose({ lastActivityAt: null, now: NOW })).toBe(false);
  });

  test("the window is overridable, because a test cannot wait out the real one", () => {
    expect(shouldClose({ lastActivityAt: NOW - 100, now: NOW }, 50)).toBe(true);
  });
});

describe("moving to the bottom of the topic", () => {
  test("something landing after the status moves it", () => {
    // Pinned means findable, not visible. Three replies later it is off the
    // screen, and the operator asked to see the work, not to go looking for it.
    expect(shouldMove({ statusMessageId: 100, lastOtherMessageId: 101, movedFor: null })).toBe(true);
  });

  test("nothing landing after it leaves it where it is", () => {
    expect(shouldMove({ statusMessageId: 100, lastOtherMessageId: 99, movedFor: null })).toBe(false);
    expect(shouldMove({ statusMessageId: 100, lastOtherMessageId: null, movedFor: null })).toBe(false);
  });

  test("one event moves it once, however many times it is asked", () => {
    // The question is asked on every edit — every few seconds — and a move is a
    // delete plus a send. Moving on each would be a blizzard in the topic and a
    // rate limit in the face.
    const moved = { statusMessageId: 100, lastOtherMessageId: 101, movedFor: 101 };

    expect(shouldMove(moved)).toBe(false);
  });

  test("the next thing to land moves it again", () => {
    expect(shouldMove({ statusMessageId: 100, lastOtherMessageId: 102, movedFor: 101 })).toBe(true);
  });
});

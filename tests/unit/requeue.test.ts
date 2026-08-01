/**
 * The mark that keeps two retry paths from fighting over one question.
 *
 * The response guard re-queues the moment a turn dies; the supervisor's
 * unanswered-message loop sweeps up later. Each has to see the other's mark,
 * or a question nobody ever answers gets re-queued forever.
 */

import { describe, expect, test } from "bun:test";
import { isRequeued, markRequeued } from "../../utils/requeue.ts";

const GUARD_NOTE = "Re-queued — the previous turn ended without a reply. Process normally.";
const SUPERVISOR_NOTE = "Re-injected — previous response was lost during a Claude Code disconnect. Process normally.";

describe("markRequeued", () => {
  test("keeps the original question intact below the note", () => {
    const marked = markRequeued("какой прогресс?", GUARD_NOTE);
    expect(marked.endsWith("\nкакой прогресс?")).toBe(true);
    expect(marked).toContain(GUARD_NOTE);
  });

  test("a marked question reads as marked", () => {
    expect(isRequeued(markRequeued("test", GUARD_NOTE))).toBe(true);
  });
});

describe("isRequeued", () => {
  test("an untouched question is not marked", () => {
    expect(isRequeued("какой прогресс?")).toBe(false);
    expect(isRequeued("")).toBe(false);
  });

  test("each path recognises the other's mark", () => {
    expect(isRequeued(markRequeued("q", SUPERVISOR_NOTE))).toBe(true);
    expect(isRequeued(markRequeued("q", GUARD_NOTE))).toBe(true);
  });

  test("the mark still reads through leading whitespace", () => {
    expect(isRequeued(`\n  ${markRequeued("q", GUARD_NOTE)}`)).toBe(true);
  });

  // The mark has to open the message. A question that merely mentions the
  // symbol is an ordinary question and deserves its retry.
  test("the symbol elsewhere in the text is not a mark", () => {
    expect(isRequeued("почему в логах ♻️?")).toBe(false);
    expect(isRequeued("[note] ♻️ later")).toBe(false);
  });

  test("marking twice is still one mark", () => {
    const once = markRequeued("q", GUARD_NOTE);
    expect(isRequeued(once)).toBe(true);
    // The caller is expected to check first; if it does, nothing double-wraps.
    expect(isRequeued(once) ? once : markRequeued(once, GUARD_NOTE)).toBe(once);
  });
});

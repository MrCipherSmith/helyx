/**
 * Scoping of pending steps.
 *
 * A prompt that waits for the operator's next message is keyed by conversation,
 * not by chat: every topic in a forum shares one chat id, and keying by chat
 * alone let an add-flow opened in one topic eat the next message typed in
 * another.
 */

import { describe, expect, test } from "bun:test";
import {
  looksLikeCommand,
  pendingScope,
  pendingInput,
  setPendingInput,
  clearPendingInput,
  pendingToolInput,
  setPendingTool,
  clearPendingTool,
} from "../../bot/handlers.ts";

/** Minimal stand-in for the parts of a grammY context that scoping reads. */
function ctxIn(chatId: number, msg?: { thread?: number; forum?: boolean }): any {
  return {
    chat: { id: chatId, is_forum: msg?.forum ?? false },
    msg: msg && { message_thread_id: msg.thread },
  };
}

const noop = async () => {};

describe("pendingScope", () => {
  test("a chat without threads is its own scope", () => {
    expect(pendingScope(ctxIn(-100))).toBe("-100");
  });

  test("forum topics in one chat are separate scopes", () => {
    const a = pendingScope(ctxIn(-100, { thread: 7, forum: true }));
    const b = pendingScope(ctxIn(-100, { thread: 9, forum: true }));
    expect(a).not.toBe(b);
    expect(a).toBe("-100:7");
  });

  // A plain group puts message_thread_id on any reply chain. The operator is
  // under no obligation to answer inside it, so it must not narrow the scope.
  test("a reply chain outside a forum does not narrow the scope", () => {
    expect(pendingScope(ctxIn(-100, { thread: 7, forum: false }))).toBe("-100");
  });

  test("a context with no message at all still scopes to the chat", () => {
    expect(pendingScope(ctxIn(-100))).toBe("-100");
  });
});

describe("what counts as a command for cancelling a step", () => {
  test("a bare command cancels", () => {
    expect(looksLikeCommand("/projects")).toBe(true);
    expect(looksLikeCommand("/switch 3")).toBe(true);
  });

  test("a command addressed to the bot cancels", () => {
    expect(looksLikeCommand("/projects@helyx_grace_bot")).toBe(true);
    expect(looksLikeCommand("/providers@helyx_grace_bot add")).toBe(true);
  });

  // /project_add asks for an absolute path; it must reach the step that asked.
  test("an absolute path is not a command", () => {
    expect(looksLikeCommand("/home/altsay/bots/helyx")).toBe(false);
    expect(looksLikeCommand("/usr/local")).toBe(false);
  });

  test("ordinary text is not a command", () => {
    expect(looksLikeCommand("ok")).toBe(false);
    expect(looksLikeCommand("anthropic/claude-opus-5, openai/gpt-oss-20b:free")).toBe(false);
    expect(looksLikeCommand("")).toBe(false);
  });

  test("a slash on its own is not a command", () => {
    expect(looksLikeCommand("/")).toBe(false);
    expect(looksLikeCommand("/ hello")).toBe(false);
  });
});

describe("pending input is scoped to its topic", () => {
  test("a step armed in one topic is invisible in another", () => {
    const topicA = ctxIn(-100, { thread: 7, forum: true });
    const topicB = ctxIn(-100, { thread: 9, forum: true });

    setPendingInput(topicA, noop, 60_000);
    expect(pendingInput.has(pendingScope(topicA))).toBe(true);
    expect(pendingInput.has(pendingScope(topicB))).toBe(false);

    clearPendingInput(topicA);
    expect(pendingInput.has(pendingScope(topicA))).toBe(false);
  });

  test("clearing one topic leaves the other armed", () => {
    const topicA = ctxIn(-200, { thread: 1, forum: true });
    const topicB = ctxIn(-200, { thread: 2, forum: true });

    setPendingInput(topicA, noop, 60_000);
    setPendingInput(topicB, noop, 60_000);
    clearPendingInput(topicA);

    expect(pendingInput.has(pendingScope(topicA))).toBe(false);
    expect(pendingInput.has(pendingScope(topicB))).toBe(true);
    clearPendingInput(topicB);
  });

  test("clearing a scope that holds nothing is a no-op", () => {
    const topic = ctxIn(-300, { thread: 4, forum: true });
    expect(() => clearPendingInput(topic)).not.toThrow();
    expect(pendingInput.has(pendingScope(topic))).toBe(false);
  });
});

describe("pending tool arguments are scoped the same way", () => {
  test("a tool prompt armed in one topic is invisible in another", () => {
    const topicA = ctxIn(-400, { thread: 3, forum: true });
    const topicB = ctxIn(-400, { thread: 5, forum: true });

    setPendingTool(topicA, { type: "skill", name: "commit" });
    expect(pendingToolInput.get(pendingScope(topicA))?.name).toBe("commit");
    expect(pendingToolInput.has(pendingScope(topicB))).toBe(false);

    clearPendingTool(topicA);
    expect(pendingToolInput.has(pendingScope(topicA))).toBe(false);
  });
});

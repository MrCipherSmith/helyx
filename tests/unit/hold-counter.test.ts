import { describe, test, expect } from "bun:test";
import { HoldCounter } from "../../utils/hold-counter.ts";

/**
 * The counted hold behind the "blocked on a permission prompt" signal.
 *
 * A flag would do if only one thing could hold a key at a time. Two prompts
 * can be pending in one chat, and with a flag the first to finish would clear
 * the signal while the second was still blocked — the operator would watch 💬
 * disappear and conclude the session had been unblocked.
 */

describe("HoldCounter", () => {
  test("a key starts free", () => {
    expect(new HoldCounter().isHeld("chat")).toBe(false);
  });

  test("acquire holds it, release frees it", () => {
    const c = new HoldCounter();
    c.acquire("chat");
    expect(c.isHeld("chat")).toBe(true);
    c.release("chat");
    expect(c.isHeld("chat")).toBe(false);
  });

  test("two overlapping holders do not clear each other", () => {
    // The reason this is counted. Two prompts pending in one chat: the first
    // to finish must not take the signal down while the second is still up.
    const c = new HoldCounter();
    c.acquire("chat");
    c.acquire("chat");
    c.release("chat");
    expect(c.isHeld("chat")).toBe(true);
    c.release("chat");
    expect(c.isHeld("chat")).toBe(false);
  });

  test("depth reports how many are holding", () => {
    const c = new HoldCounter();
    c.acquire("chat");
    c.acquire("chat");
    c.acquire("chat");
    expect(c.depth("chat")).toBe(3);
    c.release("chat");
    expect(c.depth("chat")).toBe(2);
  });

  test("releasing more than was acquired does not go negative", () => {
    // Callers pair acquire with release in a finally; a stray extra release
    // must not leave the count below zero, or the next genuine hold would read
    // as free while it is held.
    const c = new HoldCounter();
    c.release("chat");
    c.release("chat");
    expect(c.depth("chat")).toBe(0);
    c.acquire("chat");
    expect(c.isHeld("chat")).toBe(true);
  });

  test("keys are independent", () => {
    const c = new HoldCounter();
    c.acquire("chat-a");
    expect(c.isHeld("chat-a")).toBe(true);
    expect(c.isHeld("chat-b")).toBe(false);
    c.release("chat-a");
    c.acquire("chat-b");
    expect(c.isHeld("chat-a")).toBe(false);
    expect(c.isHeld("chat-b")).toBe(true);
  });

  test("a released key is forgotten rather than kept at zero", () => {
    // Chats come and go; the map should not grow for every one that ever had
    // a prompt.
    const c = new HoldCounter();
    c.acquire("chat");
    c.release("chat");
    expect(c.depth("chat")).toBe(0);
    expect(c.isHeld("chat")).toBe(false);
  });
});

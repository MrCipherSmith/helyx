import { describe, test, expect } from "bun:test";
import { HoldCounter } from "../../utils/hold-counter.ts";

/**
 * The counted hold behind the "blocked on a permission prompt" signal.
 *
 * A flag would do if only one thing could hold a key at a time. Two prompts
 * can be pending in one chat, and with a flag the first to finish would clear
 * the signal while the second was still blocked — the operator would watch 💬
 * disappear and conclude the session had been unblocked.
 *
 * `acquire` hands back the function that releases *that* hold. Releases need
 * identity: a keyed `release(key)` has no way to tell whose hold it is
 * dropping, so one holder calling it twice consumes another's.
 */

describe("HoldCounter", () => {
  test("a key starts free", () => {
    expect(new HoldCounter().isHeld("chat")).toBe(false);
  });

  test("acquire holds it, the returned lease frees it", () => {
    const c = new HoldCounter();
    const release = c.acquire("chat");
    expect(c.isHeld("chat")).toBe(true);
    release();
    expect(c.isHeld("chat")).toBe(false);
  });

  test("two overlapping holders do not clear each other", () => {
    // The reason this is counted. Two prompts pending in one chat: the first
    // to finish must not take the signal down while the second is still up.
    const c = new HoldCounter();
    const first = c.acquire("chat");
    const second = c.acquire("chat");
    first();
    expect(c.isHeld("chat")).toBe(true);
    second();
    expect(c.isHeld("chat")).toBe(false);
  });

  test("releasing a lease twice does not consume another holder's hold", () => {
    // The failure a keyed release cannot prevent: the first prompt's `finally`
    // runs, something calls it again, and the second prompt — still blocked —
    // loses its signal.
    const c = new HoldCounter();
    const first = c.acquire("chat");
    const second = c.acquire("chat");
    first();
    first();
    first();
    expect(c.depth("chat")).toBe(1);
    expect(c.isHeld("chat")).toBe(true);
    second();
    expect(c.isHeld("chat")).toBe(false);
  });

  test("leases are independent of the order they are released in", () => {
    const c = new HoldCounter();
    const first = c.acquire("chat");
    const second = c.acquire("chat");
    second();
    expect(c.isHeld("chat")).toBe(true);
    first();
    expect(c.isHeld("chat")).toBe(false);
  });

  test("depth reports how many are holding", () => {
    const c = new HoldCounter();
    const a = c.acquire("chat");
    c.acquire("chat");
    c.acquire("chat");
    expect(c.depth("chat")).toBe(3);
    a();
    expect(c.depth("chat")).toBe(2);
  });

  test("keys are independent", () => {
    const c = new HoldCounter();
    const a = c.acquire("chat-a");
    expect(c.isHeld("chat-a")).toBe(true);
    expect(c.isHeld("chat-b")).toBe(false);
    a();
    const b = c.acquire("chat-b");
    expect(c.isHeld("chat-a")).toBe(false);
    expect(c.isHeld("chat-b")).toBe(true);
    b();
  });

  test("a released key is forgotten rather than kept at zero", () => {
    // Chats come and go; the map should not grow for every one that ever had
    // a prompt.
    const c = new HoldCounter();
    c.acquire("chat")();
    expect(c.depth("chat")).toBe(0);
    expect(c.isHeld("chat")).toBe(false);
  });

  test("a lease keeps working after the key was emptied and taken again", () => {
    // Its own hold is gone, so it must do nothing — not decrement whatever
    // holds the key now.
    const c = new HoldCounter();
    const stale = c.acquire("chat");
    stale();
    const fresh = c.acquire("chat");
    stale();
    expect(c.isHeld("chat")).toBe(true);
    fresh();
    expect(c.isHeld("chat")).toBe(false);
  });
});

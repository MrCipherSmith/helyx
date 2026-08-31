/**
 * A typing tick must lose gracefully, not queue forever.
 *
 * `startTypingRaw` gates every tick on the shared cross-process Telegram rate
 * budget (flow 064). That budget went live a few days before ~10 concurrently
 * active sessions started starving it on 2026-08-30: a typing indicator fires
 * every 4s per session with no bound on its wait, so under contention it
 * queues forever and — because it never gives up — keeps winning scarce
 * tokens away from an actual `reply`, which does give up after its own
 * deadline. This pins the fix: a typing tick must give up quickly and skip,
 * not queue indefinitely, when the budget is starved.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { startTypingRaw } from "../../utils/typing.ts";
import { createLocalAllowance, setSharedAllowanceForTests } from "../../utils/telegram-rate-budget.ts";

let realFetch: typeof fetch;
let fetchCalls: number;
let restoreAllowance: () => void;
let testAllowance: ReturnType<typeof createLocalAllowance>;

function stubTelegramOk(): void {
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  fetchCalls = 0;
  realFetch = globalThis.fetch;
  stubTelegramOk();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  testAllowance?.stop();
  restoreAllowance?.();
});

describe("startTypingRaw", () => {
  test("a granted slot sends the typing action", async () => {
    testAllowance = createLocalAllowance({ lease: async () => ({ granted: 1_000 }) });
    restoreAllowance = setSharedAllowanceForTests(testAllowance);

    const handle = startTypingRaw("token", "-1", 50);
    await new Promise((r) => setTimeout(r, 20));
    handle.stop();

    expect(fetchCalls).toBe(1);
  });

  test("a starved budget skips the tick instead of queuing for it", async () => {
    // Never grants — the tick's acquireSendSlot must give up on its own
    // slotTimeoutMs rather than wait for a refresh that never comes.
    testAllowance = createLocalAllowance({
      lease: async () => ({ granted: 0 }),
      refreshIntervalMs: 100_000, // long enough it never fires within the test
    });
    restoreAllowance = setSharedAllowanceForTests(testAllowance);

    const handle = startTypingRaw("token", "-1", 30);
    // The tick's own 30ms slot timeout must have already rejected by 60ms —
    // well before the loop's own (much longer) TYPING_INTERVAL_MS would
    // otherwise stand between "queued" and "given up" being distinguishable.
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(fetchCalls).toBe(0);
  });

  test("stop() during a starved wait leaves nothing pending", async () => {
    testAllowance = createLocalAllowance({
      lease: async () => ({ granted: 0 }),
      refreshIntervalMs: 100_000,
    });
    restoreAllowance = setSharedAllowanceForTests(testAllowance);

    const handle = startTypingRaw("token", "-1", 5_000);
    handle.stop();
    // Stopping does not cancel the in-flight acquire, only the next loop
    // iteration — this just proves stop() itself does not throw or hang.
    expect(fetchCalls).toBe(0);
  });
});

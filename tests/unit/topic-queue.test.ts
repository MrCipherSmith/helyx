/**
 * A hung task must not jam its topic forever.
 *
 * Every message for a topic chains onto the same promise, one at a time. That
 * is fine as long as each task eventually settles — but a voice message on
 * 2026-08-28 logged "received" and then nothing: no download, no transcribe,
 * no error, because an earlier task for that topic never resolved or rejected.
 * With no timeout on the task itself, the chain just waits forever and every
 * later message — voice or text — piles up silently behind it until the bot
 * process restarts. This pins the timeout that stops that from happening again.
 */

import { describe, expect, test } from "bun:test";
import { enqueueForTopic, runWithTimeout } from "../../bot/topic-queue.ts";

/** A promise that never settles — stands in for a hung network call or wedged DB query. */
function hang(): Promise<void> {
  return new Promise<void>(() => {});
}

describe("runWithTimeout", () => {
  test("a task that settles well within the deadline resolves normally", async () => {
    await expect(runWithTimeout(async () => {}, "k", 50)).resolves.toBeUndefined();
  });

  test("a task that never settles rejects once the deadline passes", async () => {
    await expect(runWithTimeout(hang, "k", 20)).rejects.toThrow(/exceeded 20ms/);
  });

  test("a task that rejects on its own still rejects with its own error, not a timeout", async () => {
    await expect(
      runWithTimeout(async () => { throw new Error("boom"); }, "k", 1000),
    ).rejects.toThrow("boom");
  });
});

describe("enqueueForTopic", () => {
  test("a hung task times out without blocking a chained task on the same topic", async () => {
    // enqueueForTopic chains each task as prev.then(() => runWithTimeout(task, key))
    // — the exact case that jammed the Vantage FrontEnd topic on 2026-08-28. This
    // reproduces that chain directly so the timeout can be short instead of the
    // real 5-minute TASK_TIMEOUT_MS.
    const key = `test-hang-${Date.now()}`;
    const order: string[] = [];

    const first = runWithTimeout(hang, key, 20).catch(() => { order.push("first-timed-out"); });
    const second = first.then(() => runWithTimeout(async () => { order.push("second-ran"); }, key, 1000));

    await second;
    expect(order).toEqual(["first-timed-out", "second-ran"]);
  });

  test("tasks for the same key still run strictly in order when nothing hangs", async () => {
    const key = `test-order-${Date.now()}`;
    const order: number[] = [];

    enqueueForTopic(key, async () => { order.push(1); });
    enqueueForTopic(key, async () => { order.push(2); });
    enqueueForTopic(key, async () => { order.push(3); });

    // Give the microtask/macrotask chain a tick to drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1, 2, 3]);
  });

  test("a hung task on one topic does not block a different topic", async () => {
    const stuckKey = `test-stuck-${Date.now()}`;
    const freeKey = `test-free-${Date.now()}`;
    let freeRan = false;

    enqueueForTopic(stuckKey, hang);
    enqueueForTopic(freeKey, async () => { freeRan = true; });

    await new Promise((r) => setTimeout(r, 10));
    expect(freeRan).toBe(true);
  });
});

/**
 * Requeuing after a lost `mcp.notification` deadline, only once delivery has
 * actually failed.
 *
 * `withDeadline` races the notification write against a 5s timer; it does not
 * cancel the write, so a deadline exceeded is not proof the message never
 * reached Claude. The old code reset `delivered = false` the instant the
 * deadline fired — while the original write was still in flight. If that
 * write later landed, the row had already been (or was about to be) requeued
 * and resent: the same content delivered twice, nothing to detect it.
 *
 * `settleAfterDeadline` is the fix, factored out of `start()`'s delivery loop
 * so it can be driven directly: a controlled promise stands in for
 * `mcp.notification`, and the assertion is on whether `message_queue` was
 * touched — never while the promise is still pending, only after it rejects,
 * never after it resolves. F-010 (channel/poller.ts:455).
 */

import { describe, test, expect } from "bun:test";
import { settleAfterDeadline } from "../../channel/poller.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

const RESET = "UPDATE message_queue SET delivered = false";

/** A promise this test settles by hand, plus the trigger to do it. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("settleAfterDeadline", () => {
  test("does not requeue while the original write is still pending", async () => {
    const db = new FakeSql();
    const { promise } = deferred<void>();

    settleAfterDeadline(promise, db.sql as never, 7, "-100123");
    await flush();

    expect(db.count(RESET)).toBe(0);
  });

  test("a late success leaves delivered=true — no requeue", async () => {
    const db = new FakeSql();
    const { promise, resolve } = deferred<void>();

    settleAfterDeadline(promise, db.sql as never, 7, "-100123");
    resolve();
    await flush();

    expect(db.count(RESET)).toBe(0);
  });

  test("a confirmed failure resets delivered=false — safe to requeue", async () => {
    const db = new FakeSql();
    const { promise, reject } = deferred<void>();

    settleAfterDeadline(promise, db.sql as never, 7, "-100123");
    reject(new Error("stdin pipe closed"));
    await flush();

    expect(db.count(RESET)).toBe(1);
    expect(db.matching(RESET)[0]!.values).toEqual([7]);
  });

  test("the row id in the reset matches the row that actually failed", async () => {
    const db = new FakeSql();
    const a = deferred<void>();
    const b = deferred<void>();

    settleAfterDeadline(a.promise, db.sql as never, 1, "-100123");
    settleAfterDeadline(b.promise, db.sql as never, 2, "-100123");
    a.resolve();
    b.reject(new Error("dead"));
    await flush();

    expect(db.count(RESET)).toBe(1);
    expect(db.matching(RESET)[0]!.values).toEqual([2]);
  });
});

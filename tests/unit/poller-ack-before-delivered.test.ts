/**
 * AC8 (flow 065) — a `message_queue` row must not be marked delivered before
 * its downstream `mcp.notification` is acknowledged, and a rejected
 * notification must revert the row to a retryable state.
 *
 * `channel/poller.ts:353-378` dequeues and marks `delivered = true` in the
 * *same* `UPDATE ... RETURNING` statement, before `mcp.notification` (the
 * call that actually hands the message to Claude) is even built, let alone
 * awaited. `settleAfterDeadline` (tested in poller-deadline-settle.test.ts)
 * does correctly reset `delivered = false` once a notification is confirmed
 * to have failed — but only for the branch that fires after the *5s
 * deadline itself* has been exceeded. `start()`'s own `.catch()` on the
 * `withDeadline(...).then(...)` race — the path a notification that rejects
 * in, say, 50ms actually takes — never enters that branch at all:
 *
 *   withDeadline(notificationPromise, 5_000, "mcp.notification")
 *     .then((result) => {
 *       if (result === DEADLINE_EXCEEDED) {
 *         settleAfterDeadline(notificationPromise, this.ctx.sql, row.id, row.chat_id);
 *       }
 *     })
 *     .catch((err) => channelLogger.warn({ err }, "mcp.notification failed"));
 *
 * A fast rejection only logs a warning. Nothing ever touches `message_queue`
 * again, so the row stays `delivered = true` — set by the very statement
 * that dequeued it — forever, even though delivery is known, immediately, to
 * have failed. See docs/report/helyx-telegram-delivery-incident/2026-09-02-report.md
 * section 10.1.
 *
 * Both tests are written against the target model the report and AC8 name —
 * explicit queued/inflight/delivered states that only become `delivered`
 * once the notification is acknowledged, and that revert to retryable on a
 * rejection regardless of how fast it arrives — so both fail against today's
 * boolean `delivered` column and today's fire-and-forget `.catch()`.
 *
 * Harness: the same one `poller-limit-hold.test.ts` established for driving
 * `start()` — a poller wired to a `FakeSql` and a stub status manager, run
 * unawaited and stopped after letting the loop turn over a few times. That
 * file's own comment explains why: `start()` is an infinite loop around a
 * database, an MCP client and Telegram, and this drives only the one thing
 * these tests are about — what happens to `message_queue` around the
 * `mcp.notification` call.
 */

import { describe, test, expect } from "bun:test";
import { MessageQueuePoller, type PollerContext } from "../../channel/poller.ts";
import type { StatusManager } from "../../channel/status.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

const SELECT_METADATA = "SELECT metadata FROM sessions";
const DEQUEUE = "UPDATE message_queue SET delivered = true WHERE id IN";
const RESET = "UPDATE message_queue SET delivered = false";
// The fix's replacement for DEQUEUE: claims a row into an in-flight state
// (`claimed_at`) without marking it delivered — this is the query text a
// correct implementation actually sends instead of DEQUEUE. Fixture-only:
// it supplies the harness with a row so the loop has something to hand to
// `mcp.notification`, exactly as DEQUEUE used to for the pre-fix statement it
// replaces. Neither assertion below reads this constant — DEQUEUE and RESET,
// the two assertions the tests are graded on, are unchanged.
const CLAIM = "UPDATE message_queue SET claimed_at = now() WHERE id IN";

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function queuedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    chat_id: "-100999",
    from_user: "alice",
    content: "why did it fail?",
    message_id: "555",
    created_at: new Date(),
    attachments: null,
    reply_context: null,
    ...overrides,
  };
}

/** No-op status stub — only the methods `start()`'s delivery loop actually calls. */
function fakeStatus(): StatusManager {
  return {
    getBusyChats: () => new Set<string>(),
    deleteStatusMessage: async () => {},
    startTypingForChat: () => {},
    setQuestion: () => {},
    sendStatusMessage: async () => {},
    startProgressMonitorForChat: async () => {},
    armResponseGuard: () => {},
  } as unknown as StatusManager;
}

/**
 * A poller wired to a fake database, a stub status manager, and a
 * controllable `mcp.notification` — the one thing each test varies.
 *
 * The dequeue query is programmed as a sequence: one row on the first hit,
 * then nothing — so exactly one `mcp.notification` call happens no matter
 * how many times the loop turns over before `stop()`.
 */
function poller(notification: (params: unknown) => Promise<unknown>): {
  run: () => Promise<void>;
  stop: () => void;
  db: FakeSql;
} {
  const db = new FakeSql();
  db.program(SELECT_METADATA, { rows: [{ metadata: {} }] });
  db.programSequence(CLAIM, [{ rows: [queuedRow()] }, { rows: [] }]);

  const ctx: PollerContext = {
    sql: db.sql as unknown as PollerContext["sql"],
    mcp: { notification } as unknown as PollerContext["mcp"],
    sessionId: () => 11,
    pollIntervalMs: 5,
    // Refused fast and caught, same as poller-limit-hold.test.ts: LISTEN/NOTIFY
    // is an optimisation over the poll loop, and the loop is what this is about.
    databaseUrl: "postgres://127.0.0.1:1/nonexistent",
  };

  const p = new MessageQueuePoller(ctx, fakeStatus(), () => {});
  return { run: () => p.start(), stop: () => p.stop(), db };
}

describe("a message dequeued for delivery", () => {
  test("is not marked delivered before the notification that confirms delivery is even attempted", async () => {
    // Outcome is irrelevant to this test — it resolves fast and cleanly so no
    // timer is left running past the assertion.
    const { run, stop, db } = poller(async () => ({}));
    const loop = run();

    await settle(60);
    stop();
    await loop;

    // Target model: dequeuing a row and confirming its delivery are two
    // separate writes, with a queued/inflight state in between. Today they
    // are the same statement — the SELECT that claims the row for delivery
    // is the UPDATE that marks it delivered, and `mcp.notification` has not
    // even been called yet when it runs. A fix satisfying AC8 necessarily
    // stops sending this exact combined statement.
    expect(db.count(DEQUEUE)).toBe(0);
  });

  test("a notification that rejects before the 5s deadline leaves the row delivered instead of reverting it to retryable", async () => {
    const { run, stop, db } = poller(() => Promise.reject(new Error("stdin pipe closed")));
    const loop = run();

    // Well under the 5s deadline in withDeadline() — this is the fast-reject
    // path, not the settleAfterDeadline path.
    await settle(200);
    stop();
    await loop;

    // Target model: a confirmed-failed notification reverts the row to
    // retryable no matter how quickly the failure arrives. Today `start()`'s
    // `.catch()` on this race only logs "mcp.notification failed" — nothing
    // ever issues the reset, so the row (marked delivered=true by the dequeue
    // statement, before delivery was even attempted) stays that way forever.
    expect(db.count(RESET)).toBe(1);
  });
});

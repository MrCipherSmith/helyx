/**
 * AC9 (flow 065) — `scripts/supervisor.ts`'s rescue path (Loop 7,
 * `checkUnansweredMessages`) must successfully re-queue an unanswered
 * message even though its own `message_id` already occupies a row in
 * `message_queue` — the original, already-delivered delivery.
 *
 * The rescue re-insert (around line 1902-1905) is a plain INSERT:
 *
 *   INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id, delivered)
 *   VALUES (${sessionId}, ${chatId}, ${fromUser}, ${reinjectedContent}, ${telegramMsgId}, false)
 *
 * `memory/db.ts:478-488` defines `idx_queue_msgid_dedup`, a UNIQUE index on
 * `(chat_id, message_id)` (excluding NULL/empty/'tool'), and the row this
 * INSERT collides with is exactly the original delivered=true row for the
 * same Telegram message — the one `telegram_msg_id` in the SELECT is read
 * from in the first place. So the plain INSERT raises a duplicate-key error
 * every single time the rescue path runs, is swallowed by the surrounding
 * try/catch (which only logs and `continue`s), and the operator's lost
 * message is never actually put back on the queue. `channel/status.ts`'s own
 * response guard (lines 748-762) hit the identical bug and was fixed with an
 * `INSERT ... ON CONFLICT ... DO UPDATE` — the pattern this defect still
 * needs.
 *
 * This is exactly the gap named in the report's section 10.2: the existing
 * `tests/unit/supervisor-unanswered.test.ts` drives this same function
 * against `FakeSql`, which matches on query text and does not enforce any
 * constraint — so it happily records the INSERT as sent and never observes
 * that Postgres would reject it. Only a real unique index catches this, so
 * this file uses `tests/fixtures/test-db.ts` — a real, disposable Postgres
 * database, migrated with the project's actual schema — instead of a fake
 * SQL layer.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { checkUnansweredMessages } from "../../scripts/supervisor.ts";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[supervisor-rescue-dedup-index] skipped — ${NO_DATABASE_MESSAGE}`);
}

describeWithDb("checkUnansweredMessages, against a real database with idx_queue_msgid_dedup", () => {
  let db: TestDatabase;
  let http: FakeFetch;
  let restore: () => void;
  let seq = 0;

  beforeAll(async () => {
    db = await provisionTestDatabase(); // runs the project's migrations, including v19's unique index
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    // The supervisor's alert helpers (setMessageReaction, sendMessage) hit
    // real Telegram unless a fake is installed — see fake-fetch.ts. A single
    // catch-all program is enough; these tests assert on message_queue, not
    // on what was sent to Telegram.
    ({ http, restore } = installFakeFetch());
    http.program("api.telegram.org", { json: { ok: true, result: { message_id: 1 } } });
  });

  afterEach(() => restore());

  /**
   * A session, an unanswered user message, and the message_queue row for its
   * original (already-delivered) delivery — everything `checkUnansweredMessages`'s
   * own SELECT requires to consider this chat's message lost:
   *
   *  - the session is active and not id 0
   *  - the user message is old enough (> 5 min) and not too old (< 30 min)
   *  - no assistant reply exists after it, and it is the newest user message
   *  - no undelivered row already sits in the queue for this chat
   *  - no active_status_messages row says Claude is still working on it
   *
   * The point of the fixture is the last piece: a message_queue row that is
   * already there, delivered=true, under the exact (chat_id, message_id) the
   * rescue insert will try to reuse.
   */
  async function seedUnansweredMessage(): Promise<{ sessionId: number; chatId: string; messageId: string }> {
    seq += 1;
    const clientId = `ac9-test-client-${Date.now()}-${seq}`;
    const chatId = `-100${Date.now()}${seq}`;
    const messageId = String(700_000_000 + seq);

    const [session] = await db.sql<{ id: number }[]>`
      INSERT INTO sessions (name, project, project_path, client_id, status)
      VALUES ('ac9-test-session', 'helyx-ac9-test', '/tmp/helyx-ac9', ${clientId}, 'active')
      RETURNING id
    `;
    const sessionId = session!.id;

    // The original delivery: already delivered, occupying the dedup index slot.
    await db.sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id, delivered)
      VALUES (${sessionId}, ${chatId}, 'altsay', 'почему упало?', ${messageId}, true)
    `;

    // The unanswered user message itself — old enough to qualify, no reply after it.
    await db.sql`
      INSERT INTO messages (session_id, chat_id, role, content, created_at)
      VALUES (${sessionId}, ${chatId}, 'user', 'почему упало?', now() - interval '10 minutes')
    `;

    return { sessionId, chatId, messageId };
  }

  test("AC9: the rescue re-queue succeeds despite the original delivered row already holding the (chat_id, message_id) slot", async () => {
    const { chatId, messageId } = await seedUnansweredMessage();

    await checkUnansweredMessages(db.sql);

    const rows = await db.sql<{ delivered: boolean; content: string }[]>`
      SELECT delivered, content FROM message_queue
      WHERE chat_id = ${chatId} AND message_id = ${messageId}
    `;

    // The unique index means there is exactly one row for this (chat_id,
    // message_id) no matter what — a plain INSERT either raises a duplicate
    // key (today) or an UPSERT resets the existing row (the fix). Either way
    // there is one row to look at.
    expect(rows).toHaveLength(1);

    // Target behaviour: the rescue actually rescues — the row becomes
    // retryable again, with the re-injected marker content, so the next
    // poller pass can pick it back up. Today the plain INSERT hits the
    // unique index, throws, is swallowed by the surrounding try/catch, and
    // never touches this row at all — it stays exactly as it was: delivered,
    // with its original content, never rescued.
    expect(rows[0]!.delivered).toBe(false);
    expect(rows[0]!.content).toContain("♻️");
  });

  test("AC9: today's plain INSERT actually raises the duplicate-key error idx_queue_msgid_dedup exists to raise", async () => {
    const { chatId, messageId } = await seedUnansweredMessage();

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      await checkUnansweredMessages(db.sql);
    } finally {
      console.error = originalError;
    }

    // Today: `checkUnansweredMessages` logs `[supervisor] re-inject failed
    // for ...: duplicate key value violates unique constraint
    // "idx_queue_msgid_dedup"` and moves on. Once the plain INSERT is
    // replaced with an UPSERT this log line stops happening — the rescue
    // succeeds instead of failing — so this assertion is expected to flip
    // from failing (today) to passing (after the fix) exactly like the one
    // above, just from the other direction: proving no such error is logged.
    expect(errors.some((line) => line.includes("re-inject failed"))).toBe(false);

    const [row] = await db.sql<{ delivered: boolean }[]>`
      SELECT delivered FROM message_queue WHERE chat_id = ${chatId} AND message_id = ${messageId}
    `;
    expect(row!.delivered).toBe(false);
  });
});

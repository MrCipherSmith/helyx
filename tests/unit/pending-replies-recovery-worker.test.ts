/**
 * AC4 (flow 065, T7) — pending_replies must be recovered by a periodic
 * worker, independent of bot process startup.
 *
 * Today `channel/recovery.ts`'s `deliverPendingReplies()` is called exactly
 * once, from `main.ts`'s startup sequence (see `main.ts` around line 33). No
 * `setInterval`, cron, or other periodic mechanism ever calls it again — a
 * reply that lands in `pending_replies` and then fails (rate-limit timeout,
 * transient Telegram error, process hiccup) stays invisible until the bot
 * happens to restart. This is exactly what the 2026-09-02 incident report
 * documents (`docs/report/helyx-telegram-delivery-incident/2026-09-02-report.md`,
 * section 9 and section 3's timeline): two replies sat in `pending_replies`
 * for 10-11 minutes and were only delivered because the container restarted.
 *
 * The target fix (a later task in this flow, T8 — NOT implemented here) adds
 * a bounded periodic recovery worker. This test is written directly against
 * that target contract:
 *
 *   export function startPendingReplyRecoveryWorker(
 *     sql: postgres.Sql,
 *     token: string,
 *     options?: { intervalMs?: number },
 *   ): { stop: () => void }
 *
 * exported from `channel/recovery.ts`, reusing the same delivery chain
 * `deliverPendingReplies` already has (rich -> HTML -> plain, mark
 * `delivered_at` on success). `startPendingReplyRecoveryWorker` does not
 * exist today, so this fails immediately ("... is not a function") — that
 * failure IS the proof that nothing but the startup call path recovers a
 * stuck reply. Once T8 adds a worker matching this shape, the test passes:
 * a reply stuck in `pending_replies` gets delivered within a few worker
 * ticks, with `deliverPendingReplies`/main.ts's startup path never called.
 *
 * Real Postgres, not FakeSql: this is exactly the "does time actually pass
 * and does the row actually change" question FakeSql's query-text matching
 * cannot answer — see `tests/unit/telegram-rate-budget.test.ts`'s header for
 * the same reasoning applied to `leaseBudget`.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";

const TELEGRAM_MODULE = "../../channel/telegram.ts";
const PRISTINE: Record<string, unknown> = { ...(await import(TELEGRAM_MODULE)) };

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[pending-replies-recovery-worker] skipped — ${NO_DATABASE_MESSAGE}`);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(stepMs);
  }
  return false;
}

describeWithDb("periodic recovery of pending_replies, independent of bot startup (AC4, flow 065 T7)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await provisionTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  afterEach(() => {
    mock.module(TELEGRAM_MODULE, () => ({ ...PRISTINE }));
  });

  test("a reply stuck in pending state is delivered within the worker's bounded interval, with no restart and no direct call to deliverPendingReplies", async () => {
    const CHAT_ID = "-100777888";
    const calls: { chatId: string; text: string }[] = [];

    mock.module(TELEGRAM_MODULE, () => ({
      ...PRISTINE,
      sendRichTelegramMessage: async (_token: string, chatId: string, markdown: string) => {
        calls.push({ chatId, text: markdown });
        return { ok: true, messageId: 1 };
      },
    }));

    // Simulates exactly the incident: a reply buffered to pending_replies,
    // old enough to be past deliverPendingReplies' own 30s threshold, that
    // nothing has retried because the bot never restarted.
    const [row] = await db.sql`
      INSERT INTO pending_replies (chat_id, thread_id, text, created_at)
      VALUES (${CHAT_ID}, NULL, ${"stuck reply — no restart happened"}, NOW() - INTERVAL '5 minutes')
      RETURNING id
    `;
    const pendingId = row!.id as number;

    // Forward-declared against the target contract described above — this
    // module has no such export today.
    const recoveryModule = (await import("../../channel/recovery.ts")) as unknown as {
      startPendingReplyRecoveryWorker?: (
        sql: typeof db.sql,
        token: string,
        options?: { intervalMs?: number },
      ) => { stop: () => void };
    };

    expect(typeof recoveryModule.startPendingReplyRecoveryWorker).toBe("function");
    const worker = recoveryModule.startPendingReplyRecoveryWorker!(db.sql, "fake-token", { intervalMs: 40 });

    try {
      const delivered = await waitFor(async () => {
        const [current] = await db.sql`SELECT delivered_at FROM pending_replies WHERE id = ${pendingId}`;
        return current?.delivered_at != null;
      });

      expect(delivered).toBe(true);
      expect(calls.some((c) => c.chatId === CHAT_ID)).toBe(true);
    } finally {
      worker.stop();
    }
  });
});

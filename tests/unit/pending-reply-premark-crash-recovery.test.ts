/**
 * AC5 (flow 065, T7) — the pending_replies premark/unmark around a send
 * attempt must be awaited and state-machine-driven, not fire-and-forget.
 *
 * `channel/tools.ts`'s `reply` case (~lines 536-550) does this today:
 *
 *   if (pendingReplyId) {
 *     ctx.sql`UPDATE pending_replies SET delivered_at = NOW() WHERE id = ${pendingReplyId}`.catch(() => {});
 *   }
 *   const unmarkPending = () => {
 *     if (pendingReplyId) {
 *       ctx.sql`UPDATE pending_replies SET delivered_at = NULL WHERE id = ${pendingReplyId}`.catch(() => {});
 *     }
 *   };
 *
 * Both statements are issued and never awaited. The premark sets
 * `delivered_at = NOW()` — a *terminal* "delivered" value — before the
 * Telegram send has even been attempted, purely to stop
 * `channel/recovery.ts` from double-sending on restart. There is no
 * intermediate state a crash between premark and the real send outcome
 * leaves behind: recovery only ever sees `delivered_at IS NULL` (needs
 * resending) or NOT NULL (already delivered, skip) — a reply that was
 * premarked and then never actually sent is indistinguishable from one that
 * really was delivered.
 *
 * The target fix (flow 065's later task, T8 — NOT implemented here) drives
 * `pending_replies` through an explicit `pending -> sending ->
 * delivered/failed` state machine, awaited rather than fire-and-forget, via
 * (at minimum) a new `status` column. This test is written directly against
 * that target: while a send is deliberately held open (simulating the
 * window in which a real crash could happen — the process dying before the
 * Telegram outcome is known), the row must read `status = 'sending'`, not
 * `'delivered'`. Once the send resolves as a failure, the row must land on
 * `status = 'failed'` — a state `channel/recovery.ts` can act on — not stay
 * silently marked as delivered.
 *
 * `status` does not exist on `pending_replies` today, so the first SELECT
 * below fails outright ("column ... does not exist"). That failure is this
 * test's RED: today's schema has no way to represent "sending", so the
 * TOCTOU bug this AC describes cannot even be observed, let alone fixed.
 *
 * Real Postgres, not FakeSql, because this is exactly a DB-state-over-time
 * question — see the header of `pending-replies-recovery-worker.test.ts` and
 * `tests/unit/telegram-rate-budget.test.ts` for the same reasoning.
 *
 * The real `reply` tool handler is exercised end-to-end (registerTools +
 * CallToolRequestSchema), mirroring `tests/unit/send-photo-path-guard.test.ts`
 * — only `channel/telegram.ts`'s network calls are mocked (per this task's
 * constraint against sending real Telegram messages or touching production
 * send/premark code).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import type { ToolContext } from "../../channel/tools.ts";
import type { StatusManager } from "../../channel/status.ts";

const TELEGRAM_MODULE = "../../channel/telegram.ts";
const PRISTINE: Record<string, unknown> = { ...(await import(TELEGRAM_MODULE)) };

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[pending-reply-premark-crash-recovery] skipped — ${NO_DATABASE_MESSAGE}`);
}

function statusStub(): StatusManager {
  return {
    stopTypingForChat: () => {},
    updateStatus: async () => {},
    deleteStatusMessage: async () => {},
    noteReplySent: () => {},
  } as unknown as StatusManager;
}

/** Registers the real tool handlers, wired to a real (disposable) Postgres, and returns the `reply` caller. */
async function buildReplyCaller(sql: TestDatabase["sql"]) {
  const { registerTools } = await import("../../channel/tools.ts");
  const handlers = new Map<unknown, (req: unknown) => Promise<{ content: { type: string; text: string }[] }>>();
  const mcp = {
    setRequestHandler: (schema: unknown, fn: (req: unknown) => Promise<never>) => void handlers.set(schema, fn),
  };

  const ctx: ToolContext = {
    sql: sql as unknown as ToolContext["sql"],
    mcp: mcp as never,
    sessionId: () => null,
    sessionName: () => "helyx-test",
    // Falsy: validateReplyGate short-circuits to {kind:"allow", mode:"disabled"}
    // before touching the filesystem or the DB — the State Matrix gate is not
    // what this test is about.
    projectPath: "",
    token: () => "fake-token",
    ollamaUrl: "http://127.0.0.1:1",
    embeddingModel: "unused",
  };

  registerTools(ctx, statusStub(), () => {});
  const call = handlers.get(CallToolRequestSchema);
  if (!call) throw new Error("registerTools never registered CallToolRequestSchema");

  return (args: Record<string, unknown>) => call({ params: { name: "reply", arguments: args } });
}

interface PendingRow {
  id: number;
  status: string | null;
  delivered_at: string | null;
}

async function waitForRow(sql: TestDatabase["sql"], chatId: string, timeoutMs = 2000): Promise<PendingRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<PendingRow[]>`
      SELECT id, status, delivered_at FROM pending_replies WHERE chat_id = ${chatId} ORDER BY id DESC LIMIT 1
    `;
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`no pending_replies row for chat ${chatId} within ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

describeWithDb("pending_replies premark/unmark across a send attempt (AC5, flow 065 T7)", () => {
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

  test("a crash between premark and the send outcome leaves a recoverable 'sending'/'failed' state, not a silent 'delivered' row", async () => {
    const CHAT_ID = "-100222333";

    // Deliberately held open: the send never resolves until the test says
    // so, standing in for the window in which a real process crash could
    // happen — after premark, before the Telegram outcome is known.
    let releaseSend!: (result: { ok: boolean; messageId: number | null; errorBody?: string }) => void;
    const sendGate = new Promise<{ ok: boolean; messageId: number | null; errorBody?: string }>((resolve) => {
      releaseSend = resolve;
    });

    mock.module(TELEGRAM_MODULE, () => ({
      ...PRISTINE,
      sendRichTelegramMessage: async () => sendGate,
      // Fallback path if the rich send ends up failing — must not hit the
      // real network either.
      sendTelegramMessage: async () => ({ ok: false, messageId: null, errorBody: "simulated crash — html fallback also unavailable" }),
    }));

    const reply = await buildReplyCaller(db.sql);
    const replyPromise = reply({ chat_id: CHAT_ID, text: "short reply, well under the recap threshold" });

    const row = await waitForRow(db.sql, CHAT_ID);

    // Target contract: while the send is genuinely still in flight, the row
    // must read as 'sending' — recoverable, not indistinguishable from a
    // real delivery. Fails today: no `status` column exists, and even if it
    // did, today's code jumps straight to `delivered_at = NOW()`.
    expect(row.status).toBe("sending");
    expect(row.delivered_at).toBeNull();

    // The "crash" resolves as a failure — the real-world equivalent of the
    // process dying before a successful send could ever be confirmed.
    releaseSend({ ok: false, messageId: null, errorBody: "simulated crash — send outcome unknown" });
    await replyPromise;

    const final = await waitForRow(db.sql, CHAT_ID);
    // Target contract: recovery can act on 'failed' by resending. Today's
    // fire-and-forget `unmarkPending()` sets `delivered_at = NULL` (if it
    // even lands before the process would have died) with no `status` at
    // all — not the explicit, recoverable state this AC requires.
    expect(final.status).toBe("failed");
    expect(final.delivered_at).toBeNull();
  });
});

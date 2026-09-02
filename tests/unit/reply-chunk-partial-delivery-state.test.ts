/**
 * AC7 (flow 065, T7) — a partially-delivered multi-chunk reply must not be
 * recorded as fully delivered when a non-first chunk fails.
 *
 * `channel/tools.ts`'s `sendReplyChunks()` (~lines 100-131) already tracks a
 * `lost` count and the tool's own return text says "Partially sent ... N of
 * M parts were refused" when a later chunk fails — but that only reaches the
 * model, in the tool result. The *persisted* state in `pending_replies` is
 * untouched by `lost`: the reply case (~lines 585-598) only calls
 * `unmarkPending()` when the *anchor* (first chunk) itself fails
 * (`!res.ok`). A later chunk failing while the first one succeeded leaves
 * the row exactly as the pre-send premark left it — looking fully
 * delivered — so `channel/recovery.ts` has no way to know a chunk is
 * missing and nothing ever resends it.
 *
 * The target fix (flow 065's later task, T8 — NOT implemented here) tracks
 * per-chunk delivery state so recovery can tell "partial" from "delivered"
 * and resend only what is missing. This test is written directly against
 * that target, reusing the same `status` column contract
 * `pending-reply-premark-crash-recovery.test.ts` (AC5) is written against:
 * a reply whose anchor chunk sent but a later chunk did not must land on
 * `status = 'partial'`, never `'delivered'`.
 *
 * `status` does not exist on `pending_replies` today, so the assertion
 * below fails outright ("column ... does not exist") — today's schema has
 * no way to represent "partial" at all, only "delivered or not".
 *
 * Real Postgres, not FakeSql — same reasoning as the sibling AC4/AC5 tests:
 * this is what actually landed in the row, not what a query-text fake was
 * told to answer.
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
  console.log(`[reply-chunk-partial-delivery-state] skipped — ${NO_DATABASE_MESSAGE}`);
}

function statusStub(): StatusManager {
  return {
    stopTypingForChat: () => {},
    updateStatus: async () => {},
    deleteStatusMessage: async () => {},
    noteReplySent: () => {},
  } as unknown as StatusManager;
}

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
    projectPath: "", // disables the State Matrix gate — not what this test is about
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

describeWithDb("partially-delivered multi-chunk replies (AC7, flow 065 T7)", () => {
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

  test("a failed non-first chunk is not recorded as a fully delivered reply", async () => {
    const CHAT_ID = "-100444555";
    let richCalls = 0;

    mock.module(TELEGRAM_MODULE, () => ({
      ...PRISTINE,
      sendRichTelegramMessage: async () => {
        richCalls++;
        if (richCalls === 1) return { ok: true, messageId: 100 }; // anchor chunk: delivered
        return { ok: false, messageId: null, errorBody: "simulated network glitch on chunk 2" };
      },
      sendTelegramMessage: async () => ({
        ok: false,
        messageId: null,
        errorBody: "simulated network glitch on chunk 2 (html fallback)",
      }),
    }));

    const reply = await buildReplyCaller(db.sql);
    // One long inline-code span: no newline and no space, so (a) proseOf()
    // strips it whole — shouldSummarize() is false, no spoken-recap side
    // effects to stub out — and (b) chunkMarkdown's hard-cut splitter still
    // has to break it into more than one Telegram-sized chunk.
    const longSingleLine = "`" + "x".repeat(8000) + "`";

    const result = await reply({ chat_id: CHAT_ID, text: longSingleLine });

    // Sanity: a second, non-first chunk really was attempted and really did
    // fail — otherwise this test would not be exercising AC7 at all.
    expect(richCalls).toBeGreaterThanOrEqual(2);
    expect(result.content[0]!.text).toContain("Partially sent");

    const row = await waitForRow(db.sql, CHAT_ID);
    // Target contract: per-chunk tracking must leave this as a distinct,
    // recoverable state — never indistinguishable from a full delivery.
    expect(row.status).not.toBe("delivered");
    expect(row.status).toBe("partial");
  });
});

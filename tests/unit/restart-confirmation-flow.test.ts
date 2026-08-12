/**
 * AC6, end to end through the actual button handlers.
 *
 * `action-approval-grant.test.ts` and `restart-gate.test.ts` prove the
 * mechanism — `confirmationText`, `issueOperatorGrant`, `presentGrant`. This
 * proves the mechanism is actually reached from the button an operator taps:
 * `bot/commands/system.ts`'s `sys:bounce` (and `sys:full_restart`,
 * `sys:restart_host`) and `bot/commands/supervisor-actions.ts`'s `sup:bounce`
 * no longer insert into `admin_commands` on the first tap — they issue a
 * grant and show the fingerprint in words, and only `grant:go:<id>`
 * (`bot/commands/restart-grant.ts`) enqueues anything.
 *
 * `sql` is mocked to the real per-test database from `tests/fixtures/test-db.ts`
 * rather than to a query-matching fake — `presentGrant`'s atomic UPDATE and
 * `issueOperatorGrant`'s RETURNING * need real SQL semantics, the same reason
 * the other A2 test files use this fixture. The mock.module technique itself
 * follows `admin-commands.test.ts`: installed in `beforeEach`, undone in
 * `afterEach`, never at module scope, because a top-level mock leaked into
 * five other files' tests once already.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import type { Context } from "grammy";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";

const DB_MODULE = "../../memory/db.ts";

interface FakeCtx {
  ctx: Context;
  edits: Array<{ text: string; markup: unknown }>;
  toasts: string[];
}

function callbackContext(data: string, adminChatId = "999", fromId = 100200300): FakeCtx {
  const edits: FakeCtx["edits"] = [];
  const toasts: string[] = [];
  const ctx = {
    chat: { id: Number(adminChatId) },
    from: { id: fromId },
    callbackQuery: { data },
    answerCallbackQuery: async (opts?: { text?: string }) => { toasts.push(opts?.text ?? ""); return true; },
    editMessageText: async (text: string, opts?: { reply_markup?: unknown }) => {
      edits.push({ text, markup: opts?.reply_markup });
      return true;
    },
    editMessageReplyMarkup: async () => true,
    deleteMessage: async () => true,
    reply: async () => ({ message_id: 1 }),
  } as unknown as Context;
  return { ctx, edits, toasts };
}

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[restart-confirmation-flow] skipped — ${NO_DATABASE_MESSAGE}`);
}

describeWithDb("the confirmation flow, driven through the real handlers", () => {
  let db: TestDatabase;
  let realDb: Record<string, unknown>;

  beforeAll(async () => {
    db = await provisionTestDatabase();
    process.env.TELEGRAM_CHAT_ID = "999";
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    realDb = { ...(await import("../../memory/db.ts")) };
    mock.module(DB_MODULE, () => ({ ...realDb, sql: db.sql }));
  });

  afterEach(async () => {
    mock.module(DB_MODULE, () => ({ ...realDb }));
    await db.sql`DELETE FROM action_approval_grants`;
    await db.sql`DELETE FROM admin_commands`;
  });

  test("AC6: sys:bounce states the fingerprint in words and enqueues nothing yet", async () => {
    const { handleSystemCallback } = await import("../../bot/commands/system.ts");
    const { ctx, edits, toasts } = callbackContext("sys:bounce");

    await handleSystemCallback(ctx);

    expect(toasts).toContain("Подтвердите действие");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("все сессии");
    expect(edits[0]!.text).toContain("Подтвердить?");

    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'bounce'`;
    expect(enqueued).toHaveLength(0);

    const grants = await db.sql`SELECT stated_to, half, scope, downtime, consumed_at FROM action_approval_grants WHERE pending_command = 'bounce'`;
    expect(grants).toHaveLength(1);
    expect(grants[0]!.half).toBe("sessions");
    expect(grants[0]!.scope).toBe("all");
    expect(grants[0]!.stated_to).toBe(edits[0]!.text.split("\n\n")[0]);
    expect(grants[0]!.consumed_at).toBeNull();
  });

  // Rewritten 2026-08-12: this used to assert that sys:restart_docker and
  // sys:restart_bot enqueued immediately, which was true when the gate covered
  // three commands. Both are teardown-capable and both are now gated, so the
  // assertion is inverted — every one of these four now asks first.
  test("AC6/AC15: all four teardown buttons state the fingerprint before enqueueing", async () => {
    const { handleSystemCallback } = await import("../../bot/commands/system.ts");

    for (const action of ["full_restart", "restart_host", "restart_docker", "restart_bot"]) {
      const { ctx } = callbackContext(`sys:${action}`);
      await handleSystemCallback(ctx);
    }

    const gatedRows = await db.sql`SELECT pending_command FROM action_approval_grants`;
    const gatedCommands = gatedRows.map((r) => r.pending_command).sort();
    expect(gatedCommands).toEqual(["docker_restart", "docker_restart_all", "full_restart", "host_restart"]);

    // And nothing reached the queue: an unconfirmed grant is the pending
    // state, so no admin_commands row exists until the second tap.
    const enqueued = await db.sql`SELECT command FROM admin_commands ORDER BY command`;
    expect(enqueued.map((r) => r.command)).toEqual([]);
  });

  test("the second tap (grant:go:<id>) enqueues the pending command and only then", async () => {
    const { handleSystemCallback } = await import("../../bot/commands/system.ts");
    const { handleRestartGrantCallback } = await import("../../bot/commands/restart-grant.ts");

    const first = callbackContext("sys:bounce");
    await handleSystemCallback(first.ctx);

    const [grant] = await db.sql`SELECT grant_id FROM action_approval_grants WHERE pending_command = 'bounce'`;
    const second = callbackContext(`grant:go:${grant!.grant_id}`);
    await handleRestartGrantCallback(second.ctx);

    const enqueued = await db.sql`SELECT command, payload FROM admin_commands WHERE command = 'bounce'`;
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload.grantId).toBe(grant!.grant_id);
  });

  test("sup:bounce (the supervisor topic's button) goes through the same gate", async () => {
    const { handleSupervisorCallback } = await import("../../bot/commands/supervisor-actions.ts");
    const { ctx } = callbackContext("sup:bounce");

    await handleSupervisorCallback(ctx);

    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'bounce'`;
    expect(enqueued).toHaveLength(0);
    const grants = await db.sql`SELECT grant_id FROM action_approval_grants WHERE pending_command = 'bounce'`;
    expect(grants).toHaveLength(1);
  });
});

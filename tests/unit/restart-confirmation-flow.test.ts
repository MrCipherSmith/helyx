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

  test("a different admin-chat user cannot answer someone else's confirmation", async () => {
    const { handleSystemCallback } = await import("../../bot/commands/system.ts");
    const { handleRestartGrantCallback } = await import("../../bot/commands/restart-grant.ts");

    const first = callbackContext("sys:bounce", "999", 100200300);
    await handleSystemCallback(first.ctx);

    const [grant] = await db.sql`SELECT grant_id FROM action_approval_grants WHERE pending_command = 'bounce'`;
    // Same admin chat, different Telegram user — the grant records who it
    // was issued to for exactly this check.
    const second = callbackContext(`grant:go:${grant!.grant_id}`, "999", 555999);
    await handleRestartGrantCallback(second.ctx);

    expect(second.toasts).toContain("This confirmation is not yours to answer");
    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'bounce'`;
    expect(enqueued).toHaveLength(0);
  });

  // Found in the second review: `go` enforced ownership and `cancel` did not,
  // so anyone in the admin chat could cancel someone else's pending
  // confirmation. A cancellation nobody asked for is a quiet denial of the
  // approval — the operator taps Confirm and finds the request already gone,
  // with nothing saying who took it away.
  test("grant:cancel is refused for someone else's confirmation, and the grant survives", async () => {
    const { handleSystemCallback } = await import("../../bot/commands/system.ts");
    const { handleRestartGrantCallback } = await import("../../bot/commands/restart-grant.ts");

    const first = callbackContext("sys:bounce", "999", 100200300);
    await handleSystemCallback(first.ctx);

    const [grant] = await db.sql`SELECT grant_id FROM action_approval_grants WHERE pending_command = 'bounce'`;
    const stranger = callbackContext(`grant:cancel:${grant!.grant_id}`, "999", 555999);
    await handleRestartGrantCallback(stranger.ctx);

    expect(stranger.toasts).toContain("This confirmation is not yours to answer");

    // Still answerable by the operator it belongs to.
    const [after] = await db.sql`
      SELECT consumed_at FROM action_approval_grants WHERE grant_id = ${grant!.grant_id}
    `;
    expect(after!.consumed_at).toBeNull();

    const owner = callbackContext(`grant:cancel:${grant!.grant_id}`, "999", 100200300);
    await handleRestartGrantCallback(owner.ctx);
    expect(owner.toasts).toContain("Отменено");
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

  // F1 — the four producers the review found enqueueing a gated command with
  // no grant at all: /projects → Stop, rc:kill, mon:docker_restart, and the
  // dashboard's docker_restart button (checked separately below, since it has
  // no grammY ctx). Each of these used to insert straight into
  // `admin_commands` and rely on `authorizeRestart` refusing it forever with
  // "no approver reachable" — the feature looked like it worked (the button
  // answered) and never did anything.
  test("F1: /projects → Stop states the fingerprint and enqueues nothing yet", async () => {
    const [project] = await db.sql`
      INSERT INTO projects (name, path, tmux_session_name)
      VALUES ('f1-proj', '/tmp/f1-proj', 'f1_proj')
      RETURNING id
    `;
    const { handleProjectCallback } = await import("../../bot/commands/projects.ts");
    const { ctx, edits } = callbackContext(`proj:stop:${project!.id}`);

    await handleProjectCallback(ctx);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("/tmp/f1-proj");

    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'proj_stop'`;
    expect(enqueued).toHaveLength(0);

    const grants = await db.sql`
      SELECT half, scope, downtime FROM action_approval_grants WHERE pending_command = 'proj_stop'
    `;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toEqual({ half: "sessions", scope: "/tmp/f1-proj", downtime: "full" });
  });

  test("F1: the second tap enqueues proj_stop with the project's own payload and a grantId", async () => {
    const [project] = await db.sql`
      INSERT INTO projects (name, path, tmux_session_name)
      VALUES ('f1-proj-2', '/tmp/f1-proj-2', 'f1_proj_2')
      RETURNING id
    `;
    const { handleProjectCallback } = await import("../../bot/commands/projects.ts");
    const { handleRestartGrantCallback } = await import("../../bot/commands/restart-grant.ts");

    await handleProjectCallback(callbackContext(`proj:stop:${project!.id}`).ctx);
    const [grant] = await db.sql`SELECT grant_id FROM action_approval_grants WHERE pending_command = 'proj_stop'`;
    await handleRestartGrantCallback(callbackContext(`grant:go:${grant!.grant_id}`).ctx);

    const [enqueued] = await db.sql`SELECT payload FROM admin_commands WHERE command = 'proj_stop'`;
    expect(enqueued).toBeDefined();
    expect(enqueued!.payload.project_id).toBe(project!.id);
    expect(enqueued!.payload.path).toBe("/tmp/f1-proj-2");
    expect(enqueued!.payload.grantId).toBe(grant!.grant_id);
  });

  test("F1: rc:kill (tmux_stop) states the fingerprint before enqueueing", async () => {
    const { handleRemoteControlCallback } = await import("../../bot/commands/remote-control.ts");
    const { ctx } = callbackContext("rc:kill");

    await handleRemoteControlCallback(ctx);

    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'tmux_stop'`;
    expect(enqueued).toHaveLength(0);
    const grants = await db.sql`SELECT grant_id FROM action_approval_grants WHERE pending_command = 'tmux_stop'`;
    expect(grants).toHaveLength(1);
  });

  test("F1: rc:start (tmux_start, ungated) still enqueues immediately — bring-up stays ungated", async () => {
    const { handleRemoteControlCallback } = await import("../../bot/commands/remote-control.ts");
    const { ctx } = callbackContext("rc:start");

    await handleRemoteControlCallback(ctx);

    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'tmux_start'`;
    expect(enqueued).toHaveLength(1);
  });

  test("F1: mon:docker_restart:<container> states the fingerprint before enqueueing", async () => {
    const { handleMonitorCallback } = await import("../../bot/commands/monitor.ts");
    const { ctx } = callbackContext("mon:docker_restart:helyx-postgres-1");

    await handleMonitorCallback(ctx);

    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'docker_restart'`;
    expect(enqueued).toHaveLength(0);
    const grants = await db.sql`
      SELECT scope FROM action_approval_grants WHERE pending_command = 'docker_restart'
    `;
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scope).toBe("container:helyx-postgres-1");
  });
});

// F1 — the dashboard has no grammY ctx and no two-tap flow, so it is checked
// separately: the decision recorded for it (DECISIONS_I_MADE) is to refuse a
// gated action outright rather than build a confirmation flow, so what this
// proves is the refusal, not a grant.
describeWithDb("F1: the dashboard API refuses gated admin commands rather than enqueueing them unapproved", () => {
  let db: TestDatabase;
  let realDb: Record<string, unknown>;

  beforeAll(async () => {
    db = await provisionTestDatabase();
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
    await db.sql`DELETE FROM admin_commands`;
    await db.sql`DELETE FROM projects`;
  });

  function fakeRes() {
    const chunks: string[] = [];
    let statusCode = 200;
    const res = {
      writeHead: (code: number) => { statusCode = code; },
      end: (body: string) => { chunks.push(body); },
    } as unknown as import("http").ServerResponse;
    return { res, body: () => JSON.parse(chunks.join("")), status: () => statusCode };
  }

  test("handleProjectAction('stop') refuses rather than enqueueing proj_stop", async () => {
    const dashboardApi = await import("../../mcp/dashboard-api.ts");
    const [project] = await db.sql`
      INSERT INTO projects (name, path, tmux_session_name)
      VALUES ('f1-dash-proj', '/tmp/f1-dash-proj', 'f1_dash_proj')
      RETURNING id
    `;
    const { res, body, status } = fakeRes();
    await dashboardApi.handleProjectAction({} as unknown as import("http").IncomingMessage, res, project!.id, "stop");

    expect(status()).toBe(403);
    expect(body().error).toMatch(/Telegram/);
    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'proj_stop'`;
    expect(enqueued).toHaveLength(0);
  });

  test("handleProcessAction('restart-docker') refuses rather than enqueueing docker_restart", async () => {
    const dashboardApi = await import("../../mcp/dashboard-api.ts");
    const { res, body, status } = fakeRes();
    const req = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === "end") cb();
      },
    } as unknown as import("http").IncomingMessage;
    await dashboardApi.handleProcessAction(req, res, "restart-docker");

    expect(status()).toBe(400); // "container required" — body never sent container, refusal happens before the field check would matter
    expect(body().error).toBeDefined();
  });

  test("handleProcessAction('restart-docker') with a container still refuses rather than enqueueing", async () => {
    const dashboardApi = await import("../../mcp/dashboard-api.ts");
    const { res, body, status } = fakeRes();
    const bodyText = JSON.stringify({ container: "helyx-bot-1" });
    const req = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === "data") cb(bodyText);
        if (event === "end") cb();
      },
    } as unknown as import("http").IncomingMessage;
    await dashboardApi.handleProcessAction(req, res, "restart-docker");

    expect(status()).toBe(403);
    expect(body().error).toMatch(/Telegram/);
    const enqueued = await db.sql`SELECT id FROM admin_commands WHERE command = 'docker_restart'`;
    expect(enqueued).toHaveLength(0);
  });
});

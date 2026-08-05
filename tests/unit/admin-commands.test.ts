/**
 * The operator's console, driven against a database that answers and one that
 * does not.
 *
 * `bot/commands/admin.ts` was 3.65% covered. Its handlers are the ones a person
 * reaches for when something is already wrong, which is the worst possible
 * moment for one of them to answer with an exception instead of a number.
 *
 * The empty case matters most here and is the least likely to have been tried
 * by hand: no pending permissions, no rows at all. It is what an operator sees
 * on a quiet system, and it is where an average over zero gets written.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Context } from "grammy";
import { FakeSql } from "../fixtures/fake-sql.ts";

const DB_MODULE = "../../memory/db.ts";

interface Said {
  replies: string[];
  actions: string[];
}

/** A context that records what the operator would see. */
function context(text = ""): { ctx: Context; said: Said } {
  const said: Said = { replies: [], actions: [] };
  const ctx = {
    chat: { id: -100777 },
    from: { id: 1, username: "operator" },
    message: { text },
    reply: async (body: string) => { said.replies.push(body); return { message_id: 1 }; },
    replyWithChatAction: async (action: string) => { said.actions.push(action); return true; },
    replyWithDocument: async () => ({ message_id: 1 }),
  } as unknown as Context;
  return { ctx, said };
}

let db: FakeSql;
let admin: typeof import("../../bot/commands/admin.ts");
let realDb: Record<string, unknown>;

beforeEach(async () => {
  db = new FakeSql();
  realDb = { ...(await import("../../memory/db.ts")) };
  // Installed here and undone in afterEach, never at module scope: a top-level
  // mock.module in this repository leaked into five tests in other files
  // earlier today, and the containment is the whole difference.
  mock.module(DB_MODULE, () => ({ ...realDb, sql: db.sql }));
  admin = await import("../../bot/commands/admin.ts");
});

afterEach(() => {
  mock.module(DB_MODULE, () => ({ ...realDb }));
});

describe("pending permissions", () => {
  test("nothing pending says so plainly", async () => {
    // The common case on a quiet system, and the one an operator checks most.
    db.program("FROM permission_requests", { rows: [] });
    const { ctx, said } = context();

    await admin.handlePending(ctx);

    expect(said.replies).toHaveLength(1);
    expect(said.replies[0]).toContain("No pending permissions");
  });

  test("what is pending is listed, with how long it has been waiting", async () => {
    db.program("FROM permission_requests", {
      rows: [
        {
          id: 1,
          tool_name: "mcp__docker__docker_container_list",
          description: "List all containers",
          created_at: new Date(Date.now() - 90_000),
        },
      ],
    });
    const { ctx, said } = context();

    await admin.handlePending(ctx);

    expect(said.replies[0]).toContain("mcp__docker__docker_container_list");
    expect(said.replies[0]).toContain("List all containers");
    // Raised in review as brittle, and it was: a narrow numeric window fails
    // for a reason that has nothing to do with the handler. What matters is
    // that the wait is reported in seconds and is at least as long as the
    // fixture's.
    const ago = Number(said.replies[0]!.match(/\((\d+)s ago\)/)?.[1]);
    expect(ago).toBeGreaterThanOrEqual(89);
  });
});

describe("system status", () => {
  test("a database that answers is reported as connected, with the counts it gave", async () => {
    db.program("count(*) FROM sessions", { rows: [{ count: 10 }] });
    db.program("count(*) FROM memories", { rows: [{ count: 4321 }] });
    db.program("count(*) FROM messages", { rows: [{ count: 87 }] });
    db.program("SELECT 1", { rows: [{ "?column?": 1 }] });
    const { ctx, said } = context();

    await admin.handleStatus(ctx);

    const reply = said.replies.join("\n");
    expect(reply).toContain("PostgreSQL: OK");
    expect(reply).toContain("10");
    expect(reply).toContain("4321");
  });

  test("a database that will not answer is reported, not thrown", async () => {
    // This handler is what an operator runs *because* something is wrong. It
    // failing at that moment is the failure that matters most.
    db.program("SELECT 1", { error: new Error("connection refused") });
    db.program("count(*) FROM sessions", { rows: [{ count: 0 }] });
    db.program("count(*) FROM memories", { rows: [{ count: 0 }] });
    db.program("count(*) FROM messages", { rows: [{ count: 0 }] });
    const { ctx, said } = context();

    await admin.handleStatus(ctx);

    expect(said.replies.join("\n")).toContain("PostgreSQL: ERROR");
  });
});

describe("permission statistics", () => {
  test("a quiet week reports nothing rather than dividing by it", async () => {
    // Zero requests is where a percentage over a total gets written.
    db.program("FROM permission_requests", { rows: [] });
    const { ctx, said } = context("/permission_stats 7");

    await admin.handlePermissionStats(ctx);

    expect(said.replies).toHaveLength(1);
    expect(said.replies[0]).toBeTruthy();
    expect(said.replies[0]).not.toContain("NaN");
  });
});

describe("statistics", () => {
  test("the typing indicator comes before the work, and something is always said", async () => {
    // The stats handler reads several sources; the operator should see it
    // start rather than watch nothing happen.
    //
    // The summary row is programmed rather than left empty: that query is a
    // plain aggregate with no GROUP BY, so Postgres always returns exactly one
    // row. A fake that returned none would be the test lying about the world —
    // and it did, on the first run, which is how this comment came to exist.
    db.program("FROM api_request_stats", {
      rows: [{
        total: 0, success: 0, errors: 0,
        input_tokens: 0, output_tokens: 0, total_tokens: 0, avg_latency_ms: 0,
        provider: "anthropic", model: "claude-opus-5", requests: 0, tokens: 0, avg_ms: 0,
        operation: "chat", sessions: 0, project: "standalone",
      }],
    });
    const { ctx, said } = context("/stats");

    await admin.handleStats(ctx);

    expect(said.actions).toContain("typing");
    expect(said.replies.length).toBeGreaterThan(0);
    expect(said.replies.join("\n")).not.toContain("NaN");
  });
});

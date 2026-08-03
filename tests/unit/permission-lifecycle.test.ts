/**
 * The permission request, end to end, against a fake world.
 *
 * This is the item deferred from flow 006. `pollForResponse` releases the
 * waiting hold in a `finally` rather than at each `return`, on the argument
 * that a hand-written list of exit paths is a list that can be incomplete —
 * which is exactly how flow 005's attempt at this signal ended up latching a
 * lie. That argument has never been tested. There are four ways out of the
 * poll, and each of them is asserted here separately, because "the finally
 * covers them all" is a claim about a set and a test of one member proves
 * nothing about the rest.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PermissionHandler } from "../../channel/permissions.ts";
import { makePermissionWorld } from "../fixtures/fake-permission-ctx.ts";
import { installFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram.ts";

const CHAT_ID = "555";
const REQUEST_ID = "req-1";

/** The query the poll loop asks to learn whether the operator has answered. */
const ANSWER_QUERY = "SELECT response FROM permission_requests";
/** The query it asks to learn whether the request is still outstanding. */
const STILL_OPEN_QUERY = "SELECT 1 FROM permission_requests";
/** The duplicate-notification check `handle()` runs first. */
const DEDUP_QUERY = "SELECT id FROM permission_requests";

let telegram: FakeTelegram;
let restoreTelegram: () => void;

beforeEach(async () => {
  ({ telegram, restore: restoreTelegram } = await installFakeTelegram());
});

afterEach(() => {
  restoreTelegram();
});

/**
 * A world wired for the ordinary case: not a duplicate, one session, a chat to
 * send to, and the request still open.
 *
 * `permissionTimeoutMs` defaults to something a test can wait for. The
 * production value is ten minutes, which is the right wait for a human and an
 * impossible one for a test suite.
 */
function ordinaryWorld(options: { permissionTimeoutMs?: number } = {}) {
  const world = makePermissionWorld({
    permissionTimeoutMs: options.permissionTimeoutMs ?? 600,
  });
  world.db.program(DEDUP_QUERY, { rows: [] });
  world.db.program("SELECT chat_id FROM chat_sessions", { rows: [{ chat_id: CHAT_ID }] });
  world.db.program(STILL_OPEN_QUERY, { rows: [{ "?column?": 1 }] });
  return world;
}

function params() {
  return {
    request_id: REQUEST_ID,
    tool_name: "Bash",
    description: "ls -la",
    input: { command: "ls -la" },
  };
}

describe("pollForResponse — the waiting hold is released on every exit", () => {
  test("exit 1: answered in Telegram", async () => {
    const world = ordinaryWorld();
    world.db.program(ANSWER_QUERY, { rows: [{ response: "allow" }] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    expect(world.mcp.behaviors()).toEqual(["allow"]);
    expect(world.status.holdsTaken).toBe(1);
    expect(world.status.isAwaiting(CHAT_ID)).toBe(false);
    expect(world.status.holds.depth(CHAT_ID)).toBe(0);
  });

  test("exit 2: resolved in the terminal — the request disappeared", async () => {
    const world = ordinaryWorld();
    world.db.program(ANSWER_QUERY, { rows: [] });
    world.db.program(STILL_OPEN_QUERY, { rows: [] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    // Nothing is sent back to Claude Code: the terminal already answered it,
    // and a second answer would be the handler talking over the operator.
    expect(world.mcp.behaviors()).toEqual([]);
    expect(telegram.editedContaining("Resolved in terminal")).toHaveLength(1);
    expect(world.status.holdsTaken).toBe(1);
    expect(world.status.isAwaiting(CHAT_ID)).toBe(false);
  });

  test("exit 3: timed out", async () => {
    const world = ordinaryWorld({ permissionTimeoutMs: 600 });
    world.db.program(ANSWER_QUERY, { rows: [] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    expect(world.mcp.behaviors()).toEqual(["deny"]);
    expect(world.db.count("SET status = 'expired'")).toBe(1);
    expect(telegram.editedContaining("Timeout")).toHaveLength(1);
    expect(world.status.holdsTaken).toBe(1);
    expect(world.status.isAwaiting(CHAT_ID)).toBe(false);
  });

  test("exit 4: the database threw mid-poll", async () => {
    const world = ordinaryWorld();
    world.db.program(ANSWER_QUERY, { error: new Error("connection terminated") });

    const handler = new PermissionHandler(world.ctx as never, world.status.asStatusManager());
    await expect(handler.handle(params())).rejects.toThrow("connection terminated");

    // The exception still propagates — the hold is released on the way out, not
    // swallowed. A `finally` that ate the error would pass a naive assertion on
    // the hold alone while hiding every database failure in production.
    expect(world.status.holdsTaken).toBe(1);
    expect(world.status.isAwaiting(CHAT_ID)).toBe(false);
    expect(world.status.holds.depth(CHAT_ID)).toBe(0);
  });

  test("two prompts in one chat: the signal drops only when the second lets go", async () => {
    // Not an exit path — the reason the hold is counted rather than a flag.
    const world = ordinaryWorld();
    const releaseFirst = world.status.holdAwaitingPermission(CHAT_ID);
    const releaseSecond = world.status.holdAwaitingPermission(CHAT_ID);

    releaseFirst();
    expect(world.status.isAwaiting(CHAT_ID)).toBe(true);
    releaseFirst(); // a stray second call must not consume the other holder's
    expect(world.status.isAwaiting(CHAT_ID)).toBe(true);
    releaseSecond();
    expect(world.status.isAwaiting(CHAT_ID)).toBe(false);
  });
});

describe("handle — the early returns", () => {
  test("a duplicate notification is ignored entirely", async () => {
    const world = ordinaryWorld();
    world.db.program(DEDUP_QUERY, { rows: [{ id: REQUEST_ID }] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    // Claude Code retries the notification; answering twice would resolve one
    // request with two behaviors.
    expect(world.mcp.notifications).toHaveLength(0);
    expect(telegram.sent).toHaveLength(0);
    expect(world.status.holdsTaken).toBe(0);
  });

  test("no session: nothing is sent", async () => {
    const world = makePermissionWorld({ sessionId: null });
    world.db.program(DEDUP_QUERY, { rows: [] });
    // A chat is available on purpose. Without it this test would pass even with
    // the session guard removed — the next guard would catch it — and would be
    // asserting the wrong one of the two.
    world.db.program("SELECT chat_id FROM chat_sessions", { rows: [{ chat_id: CHAT_ID }] });
    world.db.program(STILL_OPEN_QUERY, { rows: [{ "?column?": 1 }] });
    world.db.program(ANSWER_QUERY, { rows: [{ response: "allow" }] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    expect(telegram.sent).toHaveLength(0);
    expect(world.mcp.notifications).toHaveLength(0);
    expect(world.status.holdsTaken).toBe(0);
  });

  test("no chat for the session: nothing is sent", async () => {
    const world = makePermissionWorld();
    world.db.program(DEDUP_QUERY, { rows: [] });
    world.db.program("SELECT chat_id FROM chat_sessions", { rows: [] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    expect(telegram.sent).toHaveLength(0);
    expect(world.status.holdsTaken).toBe(0);
  });

  test("Telegram refused the message: auto-deny rather than wait", async () => {
    const world = ordinaryWorld();
    world.db.program(ANSWER_QUERY, { rows: [] });
    telegram.sendResult = { ok: false, messageId: null, errorBody: "chat not found" };

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    expect(world.mcp.behaviors()).toEqual(["deny"]);
    // The hold is taken only once the prompt is on the operator's screen. It
    // never got there, so the signal must never have gone up.
    expect(world.status.holdsTaken).toBe(0);
  });
});

describe("the permission timeout", () => {
  test("the override is honoured", async () => {
    const world = ordinaryWorld({ permissionTimeoutMs: 1 });
    world.db.program(ANSWER_QUERY, { rows: [] });

    const started = Date.now();
    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    expect(world.mcp.behaviors()).toEqual(["deny"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("without an override the default applies — a long wait, not none", async () => {
    // Asserted by observing that the loop keeps polling rather than by waiting
    // ten minutes for it: the third answer query throws, which ends the call.
    // If the default were absent or zero the loop would exit before polling at
    // all and the throw would never be reached.
    const world = makePermissionWorld();
    world.db.program(DEDUP_QUERY, { rows: [] });
    world.db.program("SELECT chat_id FROM chat_sessions", { rows: [{ chat_id: CHAT_ID }] });
    world.db.program(STILL_OPEN_QUERY, { rows: [{ "?column?": 1 }] });
    world.db.program(ANSWER_QUERY, {
      rows: (_values, nth) => {
        if (nth >= 2) throw new Error("stop polling");
        return [];
      },
    });

    const handler = new PermissionHandler(world.ctx as never, world.status.asStatusManager());
    await expect(handler.handle(params())).rejects.toThrow("stop polling");

    expect(world.db.count(ANSWER_QUERY)).toBe(3);
    expect(world.status.isAwaiting(CHAT_ID)).toBe(false);
  });

  test("the ten minutes is written once", async () => {
    // The call site used to spell the literal out as well, which made the
    // default dead and left the two free to drift apart.
    const source = await Bun.file("channel/permissions.ts").text();
    expect(source.match(/600_000/g) ?? []).toHaveLength(1);
  });
});

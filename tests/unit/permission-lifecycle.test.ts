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
function ordinaryWorld(
  options: { permissionTimeoutMs?: number; forumChatId?: string | null; forumTopicId?: number | null } = {},
) {
  // Forwarded rather than named one at a time: the first version of this
  // helper took only the timeout and silently dropped everything else, so a
  // test asking for forum mode got a plain world and failed on the production
  // code rather than on its own setup.
  const world = makePermissionWorld({
    ...options,
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
  /**
   * A handler that answers what it passed to `pollForResponse` instead of
   * polling.
   *
   * The earlier version of these tests asserted that an override finished
   * "within five seconds" and that the default "polled at least three times".
   * Both are true of values nobody intended — a four-second override and a
   * five-second default would have satisfied them — so they could not tell a
   * working forward from a broken one. What AC11 is actually about is which
   * number arrives, so that is what this captures.
   */
  function spyOnTimeout(world: ReturnType<typeof ordinaryWorld>) {
    const captured: (number | undefined)[] = [];
    const handler = new PermissionHandler(world.ctx as never, world.status.asStatusManager());
    // Replaced on the instance rather than by subclassing: `pollForResponse` is
    // private, and widening it to `protected` would be changing production
    // visibility to suit a test.
    (handler as unknown as Record<string, unknown>).pollForResponse = async (...args: unknown[]) => {
      captured.push(args[7] as number | undefined);
    };
    return { handler, captured };
  }

  test("the override is forwarded exactly", async () => {
    const world = ordinaryWorld({ permissionTimeoutMs: 1234 });
    const { handler, captured } = spyOnTimeout(world);

    await handler.handle(params());

    expect(captured).toEqual([1234]);
  });

  test("with no override nothing is forwarded, so the default applies", async () => {
    // `undefined` is the point: passing a number here — any number — would put
    // the value in two places again, which is the defect this flow removed.
    const world = ordinaryWorld();
    delete (world.ctx as { permissionTimeoutMs?: unknown }).permissionTimeoutMs;
    const { handler, captured } = spyOnTimeout(world);

    await handler.handle(params());

    expect(captured).toEqual([undefined]);
  });

  test("the default really is ten minutes, and it is written once", async () => {
    const source = await Bun.file("channel/permissions.ts").text();
    // The call site used to spell the literal out as well, which made the
    // default dead and left the two free to drift apart.
    expect(source.match(/600_000/g) ?? []).toHaveLength(1);
    // And the one occurrence is the default, not some unrelated constant.
    expect(source).toContain("timeoutMs = 600_000");
  });

  test("the loop keeps polling under the real default rather than falling out", async () => {
    // The forwarding tests replace the poll, so something still has to run it.
    // The third answer query throws, which ends the call: if the default were
    // absent or zero the loop would exit before polling at all and the throw
    // would never be reached.
    const world = ordinaryWorld();
    delete (world.ctx as { permissionTimeoutMs?: unknown }).permissionTimeoutMs;
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
});

describe("where a permission prompt is sent", () => {
  test("forum mode puts it in the project's topic", async () => {
    // The rule used to be covered by a private copy of it in
    // forum-topics.test.ts — a reimplementation that agreed with the handler by
    // coincidence. A prompt in the wrong chat is a prompt the operator does
    // not see, and the turn stops until it times out.
    const world = ordinaryWorld({ forumChatId: "-100888", forumTopicId: 15 });
    world.db.program(ANSWER_QUERY, { rows: [{ response: "allow" }] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    const sent = telegram.sent.at(-1)!;
    expect(sent.chatId).toBe("-100888");
    expect(sent.extra.message_thread_id).toBe(15);
  });

  test("without a topic it stays in the chat, with no thread", async () => {
    // Both halves: a stray message_thread_id on a DM send is a 400 from
    // Telegram, and the prompt never arrives at all.
    const world = ordinaryWorld();
    world.db.program(ANSWER_QUERY, { rows: [{ response: "allow" }] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    const sent = telegram.sent.at(-1)!;
    expect(sent.chatId).toBe(CHAT_ID);
    expect(sent.extra.message_thread_id).toBeUndefined();
  });

  test("a forum chat with no topic id resolved sends nothing to General", async () => {
    // Half-configured is the dangerous state: the chat is a forum but the
    // topic is unknown, and a send without a thread lands in General for
    // everyone to read.
    const world = ordinaryWorld({ forumChatId: "-100888", forumTopicId: null });
    world.db.program(ANSWER_QUERY, { rows: [{ response: "allow" }] });

    await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params());

    for (const message of telegram.sent) {
      expect([message.chatId, message.extra.message_thread_id === undefined && message.chatId === "-100888"])
        .toEqual([message.chatId, false]);
    }
  });
});

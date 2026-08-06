/**
 * Closing the turn whose answer was forwarded.
 *
 * The reported case: arena answers in its terminal without calling `reply`,
 * the Stop hook forwards the text into the topic as "итог хода" — and the
 * dialogue stops anyway. The operator's next message sat in `message_queue`
 * for two minutes forty-five, because the status the turn left open kept the
 * chat inside `getBusyChats` and the poller holds messages for busy chats
 * until the response guard gets round to them, five to ten minutes later.
 *
 * `turn-summary-delivery.test.ts` covers the sending end — that the notify
 * goes out. These are the receiving end: what the channel does with it, and
 * the one case where it must do nothing.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { parseTurnClosed } from "../../channel/poller.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1001234";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function manager() {
  const { telegram, restore } = await installFakeTelegram();
  cleanups.push(restore);

  const db = new FakeSql();
  db.program("FROM chat_sessions", { rows: [] });
  db.program("FROM message_queue", { rows: [] });

  const { StatusManager } = await import("../../channel/status.ts");
  const ctx: StatusContext = {
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => 1,
    sessionName: () => "arena",
    projectName: "arena",
    token: () => "fake-token",
  };

  const status = new StatusManager(ctx);
  cleanups.push(() => void status.deleteStatusMessage(CHAT));
  return { status, telegram, db };
}

describe("a turn whose answer was forwarded", () => {
  test("stops being busy, so the waiting message goes out", async () => {
    // The defect itself. Before this the chat stayed busy behind a finished
    // turn and the operator waited for the guard.
    const { status } = await manager();
    await status.sendStatusMessage(CHAT, "Thinking");
    expect(status.getBusyChats().has(CHAT)).toBe(true);

    const closed = await status.closeForForwardedTurn(CHAT, Date.now());

    expect(closed).toBe(true);
    expect(status.getBusyChats().has(CHAT)).toBe(false);
  });

  test("and the poller is woken rather than left to its next tick", async () => {
    // Zero perceived gap is the point: the message has been waiting for
    // minutes already, and the poll interval would add to it.
    const { status, db } = await manager();
    await status.sendStatusMessage(CHAT, "Thinking");

    await status.closeForForwardedTurn(CHAT, Date.now());

    expect(db.matching("pg_notify")[0]?.values).toEqual(["message_queue_1"]);
  });

  test("a status opened after the turn ended is left alone", async () => {
    // The race this exists for: the response guard can unblock the chat first,
    // the poller delivers the waiting message, a new turn opens its status —
    // and the hook's close arrives late. Closing then would tear down a turn
    // that is only just starting.
    const { status } = await manager();
    const turnEndedAt = Date.now() - 60_000;
    await status.sendStatusMessage(CHAT, "Thinking");

    const closed = await status.closeForForwardedTurn(CHAT, turnEndedAt);

    expect(closed).toBe(false);
    expect(status.getBusyChats().has(CHAT)).toBe(true);
  });

  test("a chat with no status at all is not an error", async () => {
    // The ordinary case for every session that does call `reply`: the tool
    // closed the status already, and the hook has nothing to forward or close.
    const { status } = await manager();

    expect(await status.closeForForwardedTurn(CHAT, Date.now())).toBe(false);
  });
});

describe("reading the payload", () => {
  test("a chat id and a timestamp", () => {
    expect(parseTurnClosed("-1003908750902:1700000000000")).toEqual({
      chatId: "-1003908750902",
      turnEndedAt: 1_700_000_000_000,
    });
  });

  test("nothing that is not both", () => {
    // Everything past the parse deletes a Telegram message, so a payload that
    // is not understood has to mean "do nothing" rather than "close chat ''".
    expect(parseTurnClosed("")).toBeNull();
    expect(parseTurnClosed(undefined)).toBeNull();
    expect(parseTurnClosed("-1001234")).toBeNull();
    expect(parseTurnClosed("-1001234:")).toBeNull();
    expect(parseTurnClosed("-1001234:soon")).toBeNull();
    expect(parseTurnClosed(":1700000000000")).toBeNull();
  });
});

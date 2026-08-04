/**
 * The guard must not call waiting-on-the-operator "silence".
 *
 * A question with buttons blocks the turn until one is pressed. The guard read
 * that as Claude having gone quiet and announced "думает уже 5+ мин" directly
 * underneath the question it was waiting for — the operator was told the
 * session was stuck, by the thing that was stuck on them.
 *
 * Driven through the real StatusManager rather than a copy of its logic: the
 * bug was in the wiring between a guard that did not ask and a check that
 * already existed, and no test of either half alone could have caught it.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1005550001";
/**
 * Both alarms, deliberately.
 *
 * The first version of this test watched only for "думает уже 5+ мин", and
 * removing the fix entirely still passed it: without the open-question check
 * the guard falls through to the *other* branch and sends "не отвечает"
 * instead. Watching one alarm while the other fires is not watching.
 */
const ALARMS = ["думает уже 5+ мин", "не отвечает"];
/** Far enough past the status's last update that the guard treats it as silence. */
const LATER = () => Date.now() + 10 * 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * A manager whose guard is about to be fired by hand.
 *
 * The timer itself is not waited on — five minutes is not a test. `runResponseGuard`
 * is the body the timer would have called.
 */
async function firedGuard(openQuestion: boolean) {
  const { telegram, restore } = await installFakeTelegram();
  cleanups.push(restore);

  const db = new FakeSql();
  db.program("FROM chat_sessions", { rows: [] });
  db.program("FROM question_requests", { rows: openQuestion ? [{ "?column?": 1 }] : [] });
  db.program("FROM message_queue", { rows: [] });

  const { StatusManager } = await import("../../channel/status.ts");
  const status = new StatusManager({
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => 7,
    sessionName: () => "helyx",
    projectName: "helyx",
    token: () => "fake-token",
  });
  cleanups.push(() => void status.deleteStatusMessage(CHAT));

  return { status, telegram, db };
}

/** Everything the bot put in the chat, sent or edited. */
const everything = (t: { texts: () => string[]; edits: { text: string }[] }) =>
  [...t.texts(), ...t.edits.map((e) => e.text)].join("\n");

describe("the response guard and an open question", () => {
  test("the check is made at all", async () => {
    // The narrow, load-bearing fact: the guard consults the open-question
    // table. It did not, and that omission is the whole bug.
    const { status, db } = await firedGuard(true);

    await status.sendStatusMessage(CHAT, "Working");
    await status.runResponseGuard(CHAT, LATER());

    expect(db.count("FROM question_requests")).toBeGreaterThan(0);
  });

  test("no alarm while the operator has a question in front of them", async () => {
    const { status, telegram } = await firedGuard(true);

    await status.sendStatusMessage(CHAT, "Working");
    await status.runResponseGuard(CHAT, LATER());

    const sent = everything(telegram);
    for (const alarm of ALARMS) expect([alarm, sent.includes(alarm)]).toEqual([alarm, false]);
  });

  test("but the alarm still fires when nothing is open", async () => {
    // The fix narrows the alarm; it does not switch it off. A session that is
    // genuinely stuck must still say so.
    const { status, telegram } = await firedGuard(false);

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, LATER());

    const sent = everything(telegram);
    expect(ALARMS.some((a) => sent.includes(a))).toBe(true);
  });

  test("a session with no id does not stop the guard working", async () => {
    // `sessionId()` is null before a session registers, and an unanswerable
    // question is not an open one.
    const { telegram, restore } = await installFakeTelegram();
    cleanups.push(restore);
    const db = new FakeSql();
    db.program("FROM chat_sessions", { rows: [] });
    db.program("FROM message_queue", { rows: [] });

    const { StatusManager } = await import("../../channel/status.ts");
    const status = new StatusManager({
      sql: db.sql as unknown as StatusContext["sql"],
      sessionId: () => null,
      sessionName: () => "helyx",
      projectName: "helyx",
      token: () => "fake-token",
    });
    cleanups.push(() => void status.deleteStatusMessage(CHAT));

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, LATER());

    const sent = everything(telegram);
    expect(ALARMS.some((a) => sent.includes(a))).toBe(true);
  });

  test("a database that refuses the question does not silence the guard", async () => {
    // Failing closed here would turn one bad query into a permanently mute
    // watchdog — the opposite of what a watchdog is for.
    const { status, telegram, db } = await firedGuard(false);
    db.program("FROM question_requests", { error: new Error("connection lost") });

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, LATER());

    const sent = everything(telegram);
    expect(ALARMS.some((a) => sent.includes(a))).toBe(true);
  });
});

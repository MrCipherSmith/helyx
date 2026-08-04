/**
 * The question reaches the message.
 *
 * `utils/status-render.ts` is tested on its own and renders the question
 * happily — and none of that proves the status manager ever hands it one. It
 * did not: the poller recorded the question, the manager stored it, and both
 * render sites built their `extras` without it, so the feature was invisible
 * while every unit test of the renderer passed. A pure test of a renderer can
 * only ever say what the renderer would do if asked.
 *
 * So these drive the real `StatusManager` and read what was sent to Telegram.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { StatusContext } from "../../channel/status.ts";
import { TELEGRAM_MAX_CHARS } from "../../utils/status-render.ts";

const CHAT = "-1001234";
const QUESTION = "почему упал деплой на стейдже?";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * A manager wired to fakes, plus the Telegram recorder it talks to.
 *
 * The module is imported *after* the Telegram fake is installed: `mock.module`
 * replaces the module registry entry, and a `channel/status.ts` already
 * imported holds the real functions.
 */
async function manager(forum?: { chatId: string; topicId: number }) {
  const { telegram, restore } = await installFakeTelegram();
  cleanups.push(restore);

  const db = new FakeSql();
  // The prefix lookup. An empty result means "this session is the active one",
  // which is the ordinary case and keeps the prefix out of the assertions.
  db.program("FROM chat_sessions", { rows: [] });

  const { StatusManager } = await import("../../channel/status.ts");
  const ctx: StatusContext = {
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => 1,
    sessionName: () => "helyx",
    projectName: "helyx",
    token: () => "fake-token",
    ...(forum
      ? { forumChatId: () => forum.chatId, forumTopicId: () => forum.topicId }
      : {}),
  };

  const status = new StatusManager(ctx);
  cleanups.push(() => void status.deleteStatusMessage(CHAT));
  return { status, telegram };
}

/** The one assertion worth making about a status message. */
function says(telegram: FakeTelegram, needle: string): boolean {
  return [...telegram.texts(), ...telegram.edits.map((e) => e.text)].some((t) => t.includes(needle));
}

describe("the question reaches the status message", () => {
  test("the first message already says what it is working on", async () => {
    // The poller records the question before the status exists, so a status
    // that only picks it up on the next edit spends its first seconds — the
    // ones the operator is actually watching — unable to say anything.
    const { status, telegram } = await manager();

    status.setQuestion(CHAT, QUESTION);
    await status.sendStatusMessage(CHAT, "Working");

    expect(telegram.sent.length).toBe(1);
    expect(telegram.sent[0]!.text).toContain(QUESTION);
  });

  test("and every edit after it", async () => {
    const { status, telegram } = await manager();

    status.setQuestion(CHAT, QUESTION);
    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "Reading files");

    expect(telegram.edits.length).toBeGreaterThan(0);
    expect(telegram.edits.at(-1)!.text).toContain(QUESTION);
  });

  test("in forum mode too", async () => {
    // The manager keys its state by chat *and* topic. `setQuestion` taking the
    // bare chat id would file the question where nothing looks for it, and the
    // failure appears only in forum mode — which is how the bot runs.
    const { status, telegram } = await manager({ chatId: "-100999", topicId: 42 });

    status.setQuestion(CHAT, QUESTION);
    await status.sendStatusMessage(CHAT, "Working");

    expect(telegram.sent[0]!.chatId).toBe("-100999");
    expect(telegram.sent[0]!.text).toContain(QUESTION);
  });

  test("no question means no empty question line", async () => {
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");

    expect(telegram.sent[0]!.text).not.toContain("❓");
  });

  test("the previous turn's question does not head the next one", async () => {
    // The status is deleted when the reply lands, which ends the turn the
    // question belonged to. Left behind, it would caption the next turn with
    // the last one's request.
    const { status, telegram } = await manager();

    status.setQuestion(CHAT, QUESTION);
    await status.sendStatusMessage(CHAT, "Working");
    await status.deleteStatusMessage(CHAT);

    telegram.sent.length = 0;
    telegram.edits.length = 0;
    await status.sendStatusMessage(CHAT, "Working on something else");

    expect(says(telegram, QUESTION)).toBe(false);
  });

  test("a question can be cleared without a new one replacing it", async () => {
    const { status, telegram } = await manager();

    status.setQuestion(CHAT, QUESTION);
    status.setQuestion(CHAT, null);
    await status.sendStatusMessage(CHAT, "Working");

    expect(says(telegram, QUESTION)).toBe(false);
  });

  test("whitespace is not a question", async () => {
    const { status, telegram } = await manager();

    status.setQuestion(CHAT, "   \n  ");
    await status.sendStatusMessage(CHAT, "Working");

    expect(telegram.sent[0]!.text).not.toContain("❓");
  });
});

describe("the completion notice", () => {
  test("a captured file path is escaped", async () => {
    // The label is scraped out of terminal output with `[^\s\n]+` and the
    // message is sent with parse_mode HTML. An unescaped bracket fails the send
    // outright, so the notice for the turn never arrives and nothing says why —
    // the same failure that once hid a supervisor alert about a lost message.
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "Editing: src/<b>.ts");
    await status.deleteStatusMessage(CHAT);

    const summary = telegram.edits.at(-1)!.text;
    expect(summary).toContain("✅");
    expect(summary).toContain("&lt;b&gt;");
    expect(summary).not.toContain("<b>");
  });

  test("and bounded", async () => {
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, `Editing: ${"p".repeat(5000)}.ts`);
    await status.deleteStatusMessage(CHAT);

    expect(telegram.edits.at(-1)!.text.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("an ordinary path is shown whole", async () => {
    // The other side of the bound: the notice exists to say what was touched.
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "Editing: channel/status.ts");
    await status.deleteStatusMessage(CHAT);

    expect(telegram.edits.at(-1)!.text).toContain("channel/status.ts");
  });
});

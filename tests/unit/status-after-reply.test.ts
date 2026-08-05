/**
 * The status message after the reply that did not end the work.
 *
 * The operator's report: an agent replies "запускаю сабагентов" and the topic
 * goes silent for minutes while it works. The reply tore the status down, and
 * the method meant to bring it back — `schedulePostReplyCheck` — was never
 * called by anything; its only trace in the repository was a comment in
 * `channel/tools.ts` promising that it would run. Meanwhile `updateStatus`
 * dropped every post-reply line on the floor to avoid creating an orphan.
 *
 * `status-continuation.test.ts` covers the three decisions in the abstract.
 * These drive the real `StatusManager` against a fake Telegram, because the
 * defect was never in the deciding — it was in the wiring, and the wiring is
 * what nothing exercised.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1001234";
/** Short enough for a test to wait one out; forty-five seconds is not a test. */
const IDLE_MS = 80;
const FLOOR_MS = 20;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function manager(options: { pendingUserMessages?: boolean } = {}) {
  const { telegram, restore } = await installFakeTelegram();
  cleanups.push(restore);

  const db = new FakeSql();
  db.program("FROM chat_sessions", { rows: [] });
  // What the re-open asks before opening: is the operator already waiting?
  db.program("FROM message_queue", { rows: options.pendingUserMessages ? [{ "?column?": 1 }] : [] });

  const { StatusManager } = await import("../../channel/status.ts");
  const ctx: StatusContext = {
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => 1,
    sessionName: () => "helyx",
    projectName: "helyx",
    token: () => "fake-token",
  };

  const status = new StatusManager(ctx, { minEditIntervalMs: FLOOR_MS, continuationIdleMs: IDLE_MS });
  cleanups.push(() => void status.deleteStatusMessage(CHAT));
  return { status, telegram, db };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A turn: status opened, work reported, reply sent. */
async function upToTheReply(status: Awaited<ReturnType<typeof manager>>["status"]) {
  await status.sendStatusMessage(CHAT, "Thinking");
  await status.updateStatus(CHAT, "● Task: three explorers");
  status.noteReplySent(CHAT, 5000);
  await status.deleteStatusMessage(CHAT);
}

describe("work that outlives its reply", () => {
  test("the next thing the session does puts a status back", async () => {
    // The reported case, end to end: the reply said what was starting, and the
    // starting is what the operator wanted to watch.
    const { status, telegram } = await manager();
    await upToTheReply(status);
    const sentBefore = telegram.sent.length;

    await status.updateStatus(CHAT, "● Explore: reading channel/status.ts");

    expect(telegram.sent.length).toBe(sentBefore + 1);
    expect(telegram.sent.at(-1)!.text).toContain("Explore");
    // Pinned like any status, and silently — the operator is not notified
    // about a message they are already watching.
    expect(telegram.pins.at(-1)!.messageId).toBe(telegram.sent.length + 999);
  });

  test("a chat whose only status is a continuation is not busy", async () => {
    // `getBusyChats` is what makes the poller hold the operator's next message
    // until the turn is over. A continuation is the tail of a turn that has
    // already answered once; reporting it busy would trade one silence for
    // another.
    const { status } = await manager();
    await upToTheReply(status);
    await status.updateStatus(CHAT, "● Explore: still reading");

    expect(status.getBusyChats().has(CHAT)).toBe(false);
  });

  test("a real turn does make the chat busy", async () => {
    // The other half of the same rule, so the first test cannot pass by the
    // flag being set on everything.
    const { status } = await manager();
    await status.sendStatusMessage(CHAT, "Thinking");

    expect(status.getBusyChats().has(CHAT)).toBe(true);
  });

  test("nothing is re-opened while the operator has a message waiting", async () => {
    // The poller is about to open a status for the next turn. Two would fight,
    // and the operator's own message would sit behind the older one.
    const { status, telegram } = await manager({ pendingUserMessages: true });
    await upToTheReply(status);
    const sentBefore = telegram.sent.length;

    await status.updateStatus(CHAT, "● Explore: reading channel/status.ts");

    expect(telegram.sent.length).toBe(sentBefore);
  });

  test("activity with no reply behind it opens nothing", async () => {
    // Stray monitor output for a chat that never replied is not a continuation
    // of anything, and a status nobody asked for is the orphan the old early
    // return was written to prevent.
    const { status, telegram } = await manager();
    const sentBefore = telegram.sent.length;

    await status.updateStatus(CHAT, "● Read: something");

    expect(telegram.sent.length).toBe(sentBefore);
  });
});

describe("closing a continuation", () => {
  test("silence closes it, and the closing is the usual summary", async () => {
    const { status, telegram } = await manager();
    await upToTheReply(status);
    await status.updateStatus(CHAT, "● Explore: reading channel/status.ts");
    const messageId = telegram.sent.length + 999;

    // Long enough for the idle window to pass and a tick to notice.
    await sleep(IDLE_MS * 3);

    expect(status.getBusyChats().has(CHAT)).toBe(false);
    expect(telegram.editedContaining("✅").length).toBeGreaterThan(0);
    expect(telegram.unpins.some((u) => u.messageId === messageId)).toBe(true);
  });

  test("activity keeps it open past the window", async () => {
    // The window is re-armed by every line, so a session that is working is
    // never closed out from under itself.
    const { status, telegram } = await manager();
    await upToTheReply(status);
    await status.updateStatus(CHAT, "● Explore: one");
    // The step's own closing summary is already on the wire — the reply wrote
    // it. What this test is about is whether a *second* one arrives.
    const closedAtStart = telegram.editedContaining("✅").length;

    for (let i = 0; i < 4; i++) {
      await sleep(IDLE_MS / 2);
      await status.updateStatus(CHAT, `● Explore: step ${i}`);
    }

    expect(telegram.editedContaining("✅").length).toBe(closedAtStart);
  });
});

describe("staying where it can be seen", () => {
  test("a status moves below what landed after it, once", async () => {
    // Pinned means findable, not visible: three replies later it is off the
    // screen. Moving is a delete plus a send, so it happens per landing and
    // never per edit — the edits run every few seconds.
    const { status, telegram } = await manager();
    await status.sendStatusMessage(CHAT, "Thinking");
    const original = telegram.sent.length + 999;

    status.noteOtherMessage(CHAT, original + 10);
    await status.updateStatus(CHAT, "● Read: one");
    await sleep(FLOOR_MS * 4);
    const movesAfterFirst = telegram.deletes.length;

    // Several more edits, no new landing: it stays where it moved to.
    for (let i = 0; i < 3; i++) {
      await sleep(FLOOR_MS * 2);
      await status.updateStatus(CHAT, `● Read: ${i}`);
    }

    expect(telegram.deletes.some((d) => d.messageId === original)).toBe(true);
    expect(telegram.deletes.length).toBe(movesAfterFirst);
  });

  test("a status with nothing after it does not move", async () => {
    const { status, telegram } = await manager();
    await status.sendStatusMessage(CHAT, "Thinking");

    await status.updateStatus(CHAT, "● Read: one");
    await sleep(FLOOR_MS * 4);

    expect(telegram.deletes).toEqual([]);
  });
});

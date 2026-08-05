/**
 * How often the status message may be edited, and what it leaves behind.
 *
 * Two findings from one turn in production, and both are about the same
 * message.
 *
 * The transcript monitor polls every two seconds and emits whenever the session
 * did anything, and every emission asked for an edit — thirty a minute into a
 * group where Telegram allows around twenty. It answered with 429s carrying
 * thirteen- and thirty-seven-second waits, and the status froze for exactly as
 * long, which reads as "the monitor is broken" rather than "the monitor is
 * being throttled".
 *
 * And when the turn ended, the closing edit replaced the whole message with its
 * summary line. The work block was not collapsed — it was overwritten, so the
 * operator coming back to the message had nothing left to expand.
 *
 * These drive the real `StatusManager` and read what reached Telegram, because
 * both defects live in the wiring rather than in the renderer, and the renderer
 * was already fully tested while both were live.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1001234";
/** Short enough that a test can wait one out, long enough to be a real gap. */
const FLOOR_MS = 60;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function manager(options: { minEditIntervalMs?: number } = {}) {
  const { telegram, restore } = await installFakeTelegram();
  cleanups.push(restore);

  const db = new FakeSql();
  db.program("FROM chat_sessions", { rows: [] });

  const { StatusManager } = await import("../../channel/status.ts");
  const ctx: StatusContext = {
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => 1,
    sessionName: () => "helyx",
    projectName: "helyx",
    token: () => "fake-token",
  };

  const status = new StatusManager(ctx, { minEditIntervalMs: FLOOR_MS, ...options });
  cleanups.push(() => void status.deleteStatusMessage(CHAT));
  return { status, telegram };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the edit floor", () => {
  test("the first update goes out immediately", async () => {
    // The floor is measured from the last edit, not from when the message was
    // sent. Starting the clock at creation would delay the one update the
    // operator is actually waiting for — the confirmation that the turn began.
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "● Read: status.ts");

    expect(telegram.edits.length).toBe(1);
  });

  test("a burst collapses into one edit", async () => {
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "● Read: a.ts");
    const after = telegram.edits.length;
    for (let i = 0; i < 10; i++) await status.updateStatus(CHAT, `● Read: b${i}.ts`);

    expect(telegram.edits.length).toBe(after);
  });

  test("and the deferred edit carries the newest state, not the queue", async () => {
    // Nothing is lost to the floor: the edit renders the state as it is when it
    // runs. A queue of deferred edits would replay stale ones instead.
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "● Read: a.ts");
    for (let i = 0; i < 10; i++) await status.updateStatus(CHAT, `● Read: b${i}.ts`);

    await sleep(FLOOR_MS * 3);

    expect(telegram.edits.length).toBe(2);
    expect(telegram.edits.at(-1)!.text).toContain("b9.ts");
    expect(telegram.edits.at(-1)!.text).not.toContain("b0.ts");
  });

  test("a deferred edit does not land after the turn is over", async () => {
    // It would repaint a finished turn as still running, on top of the closing
    // notice that had just replaced it.
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "● Read: a.ts");
    await status.updateStatus(CHAT, "● Read: b.ts"); // deferred by the floor
    await status.deleteStatusMessage(CHAT);

    const closing = telegram.edits.length;
    await sleep(FLOOR_MS * 3);

    expect(telegram.edits.length).toBe(closing);
    expect(telegram.edits.at(-1)!.text).toContain("✅");
  });
});

describe("the closing notice keeps the work", () => {
  test("the block is still in the message, collapsed", async () => {
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "● Read: status.ts\n● $ git status");
    await status.deleteStatusMessage(CHAT);

    const final = telegram.edits.at(-1)!.text;
    expect(final).toContain("✅");
    expect(final).toContain("<blockquote expandable>");
    expect(final).toContain("● Read: status.ts");
    expect(final).toContain("● $ git status");
  });

  test("a rejected block falls back to the summary rather than losing the message", async () => {
    // The block is the longest part and the only text the manager did not
    // compose itself. Deleting the message because its optional half was
    // refused would take the notice with it.
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "● Read: status.ts");
    telegram.editResult = (text: string) =>
      text.includes("<blockquote") ? { ok: false, errorBody: "Bad Request: message is too long" } : { ok: true };
    await status.deleteStatusMessage(CHAT);

    const final = telegram.edits.at(-1)!.text;
    expect(final).toContain("✅");
    expect(final).not.toContain("<blockquote");
    expect(telegram.deletes.length).toBe(0);
  });

  test("and the message is only deleted when the summary itself fails", async () => {
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Working");
    await status.updateStatus(CHAT, "● Read: status.ts");
    telegram.editResult = { ok: false, errorBody: "Bad Request: message to edit not found" };
    await status.deleteStatusMessage(CHAT);

    expect(telegram.deletes.length).toBe(1);
  });
});

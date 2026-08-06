/**
 * What the completion notice counts, and for how long it remembers counting it.
 *
 * Both monitors re-send a whole block on every poll, so the same
 * "Added N lines, removed M lines" arrives again with each new entry beneath
 * it. A set of already-counted lines is what stops one edit being counted a
 * dozen times within a turn.
 *
 * Review found the other half: that set was never cleared. A byte-identical
 * line in a *later* turn — and "Added 1 lines, removed 1 lines" is the ordinary
 * shape of a one-line edit — was dropped before it could be counted, so the
 * notice under-reported a turn that had really edited a file. These pin both
 * halves, because a fix for either one alone is a regression in the other.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1001234";
const EDIT = "● Edit: status.ts\n  └ Added 1 lines, removed 1 lines";

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
    sessionName: () => "helyx",
    projectName: "helyx",
    token: () => "fake-token",
  };

  const status = new StatusManager(ctx, { minEditIntervalMs: 0 });
  cleanups.push(() => void status.deleteStatusMessage(CHAT));
  return { status, telegram };
}

/** One turn: open, report the edit however many times, close. */
async function turn(
  status: Awaited<ReturnType<typeof manager>>["status"],
  emissions: number,
): Promise<void> {
  await status.sendStatusMessage(CHAT, "Thinking");
  for (let i = 0; i < emissions; i++) await status.updateStatus(CHAT, EDIT);
  await status.deleteStatusMessage(CHAT);
}

/** The `+X/-Y` of the last completion notice, or null when it carried none. */
function lastDiff(telegram: Awaited<ReturnType<typeof manager>>["telegram"]): string | null {
  const notices = telegram.edits.filter((e) => e.text.includes("✅"));
  const match = notices.at(-1)?.text.match(/\+(\d+)\/-(\d+)/);
  return match ? `+${match[1]}/-${match[2]}` : null;
}

describe("the diff the completion notice reports", () => {
  test("one edit reported ten times is counted once", async () => {
    const { status, telegram } = await manager();

    await turn(status, 10);

    expect(lastDiff(telegram)).toBe("+1/-1");
  });

  test("the same edit in a later turn is counted again", async () => {
    // The defect: the set of counted lines outlived the turn, so the second
    // turn's identical line was recognised as already counted and dropped —
    // and the notice said the turn had edited nothing.
    const { status, telegram } = await manager();

    await turn(status, 3);
    expect(lastDiff(telegram)).toBe("+1/-1");

    await turn(status, 3);

    expect(lastDiff(telegram)).toBe("+1/-1");
  });
});

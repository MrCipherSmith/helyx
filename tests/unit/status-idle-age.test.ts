/**
 * The idle age, against the real `StatusManager`.
 *
 * `status-render.test.ts` proves the renderer prints `⧗ 3s` when it is handed
 * three thousand milliseconds. It cannot prove the number handed over means
 * anything, and that is where review found the defect: `lastMonitorActivity` is
 * never cleared, so a turn opening with no monitor behind it would read the
 * previous turn's timestamp and announce that the session had been still for
 * eight minutes — about a session nothing was watching.
 *
 * These drive the manager against a fake Telegram, because the number's meaning
 * lives in the wiring, not in the formatting.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
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
    sessionName: () => "helyx",
    projectName: "helyx",
    token: () => "fake-token",
  };

  const status = new StatusManager(ctx, { minEditIntervalMs: 0 });
  cleanups.push(() => void status.deleteStatusMessage(CHAT));
  return { status, telegram };
}

describe("the age of the last event", () => {
  test("a status with no monitor behind it claims nothing", async () => {
    // No monitor was ever started for this chat, so nothing here knows whether
    // the session is alive. `updateStatus` still records the timestamp — it is
    // what decides the spinner's speed — and the glance line must not read that
    // timestamp as evidence of liveness it does not have.
    const { status, telegram } = await manager();

    await status.sendStatusMessage(CHAT, "Thinking");
    await status.updateStatus(CHAT, "● Read: channel/status.ts");

    const rendered = [...telegram.texts(), ...telegram.edits.map((e) => e.text)];
    expect(rendered.length).toBeGreaterThan(0);
    for (const text of rendered) expect(text).not.toContain("⧗");
  });
});

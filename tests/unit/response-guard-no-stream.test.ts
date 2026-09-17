/**
 * MiniMax answers in one block with no incremental output, so tmux sits
 * silent for the whole turn — 20-30 minutes was observed in production. The
 * response guard's streaming-shaped rearm cap (6 cycles, 30 minutes) was
 * firing on ordinary, successful replies: it deleted the status and requeued
 * a question that was never lost. `providers.streams = false` widens the cap
 * for a project on such a provider.
 *
 * Driven through the real StatusManager, repeatedly firing the guard by hand
 * the way a real 5-minute timer would, so the test exercises the same
 * rearm-count state the production bug lived in.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1005550002";
const STUCK_TEXT = "не отвечает";
const FIVE_MIN_MS = 5 * 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function managerWith(streams: boolean | null) {
  const { telegram, restore } = await installFakeTelegram();
  cleanups.push(restore);

  const db = new FakeSql();
  db.program("FROM projects", { rows: streams === null ? [] : [{ streams }] });
  db.program("FROM question_requests", { rows: [] });
  db.program("FROM message_queue", { rows: [] });

  const { StatusManager } = await import("../../channel/status.ts");
  const status = new StatusManager({
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => 7,
    sessionName: () => "helyx",
    projectName: "helyx",
    projectPath: "/home/altsay/olimpyx",
    token: () => "fake-token",
  });
  cleanups.push(() => void status.deleteStatusMessage(CHAT));

  return { status, telegram };
}

/** Every message the bot sent or edited, joined into one haystack. */
const everything = (t: { texts: () => string[]; edits: { text: string }[] }) =>
  [...t.texts(), ...t.edits.map((e) => e.text)].join("\n");

describe("response guard rearm cap for a non-streaming provider", () => {
  test("6 silent cycles do not yet declare a streams:false project stuck", async () => {
    const { status, telegram } = await managerWith(false);
    await status.sendStatusMessage(CHAT, "⏳ Thinking");

    const start = Date.now();
    for (let cycle = 1; cycle <= 6; cycle++) {
      await status.runResponseGuard(CHAT, start + cycle * FIVE_MIN_MS);
    }

    expect(everything(telegram)).not.toInclude(STUCK_TEXT);
  });

  test("a streams:true project (the pre-existing default) is stuck by cycle 6", async () => {
    const { status, telegram } = await managerWith(true);
    await status.sendStatusMessage(CHAT, "⏳ Thinking");

    const start = Date.now();
    for (let cycle = 1; cycle <= 6; cycle++) {
      await status.runResponseGuard(CHAT, start + cycle * FIVE_MIN_MS);
    }

    expect(everything(telegram)).toInclude(STUCK_TEXT);
  });

  test("a project on the default Anthropic endpoint (no providers row) keeps the tight cap", async () => {
    // provider_id is NULL for the default endpoint, so the LEFT JOIN's right
    // side is all NULL and pv.streams reads as NULL, not a row that says false.
    const { status, telegram } = await managerWith(null);
    await status.sendStatusMessage(CHAT, "⏳ Thinking");

    const start = Date.now();
    for (let cycle = 1; cycle <= 6; cycle++) {
      await status.runResponseGuard(CHAT, start + cycle * FIVE_MIN_MS);
    }

    expect(everything(telegram)).toInclude(STUCK_TEXT);
  });

  test("a streams:false project is still eventually declared stuck", async () => {
    // The cap widens, it does not disappear — a genuinely dead session on a
    // non-streaming provider must still be reported.
    const { status, telegram } = await managerWith(false);
    await status.sendStatusMessage(CHAT, "⏳ Thinking");

    const start = Date.now();
    for (let cycle = 1; cycle <= 24; cycle++) {
      await status.runResponseGuard(CHAT, start + cycle * FIVE_MIN_MS);
    }

    expect(everything(telegram)).toInclude(STUCK_TEXT);
  });
});

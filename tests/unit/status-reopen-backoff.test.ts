/**
 * `maybeReopen`'s backoff and cap, against the real `StatusManager`.
 *
 * The incident: a channel retried a failing continuation-reopen on every
 * activity-monitor poll tick — as fast as every 2s — forever, because nothing
 * remembered that the previous attempt had failed. Observed in production on
 * 2026-09-01 as a session retrying "opening a continuation" every ~8s for
 * 12+ hours, each attempt spending a token from the `BACKGROUND_LANE` in
 * `utils/telegram-rate-budget.ts` — one Postgres row shared across every
 * concurrently-running project session — which is why unrelated sessions'
 * real replies were also failing that day.
 *
 * These prove the fix without waiting out real backoff windows: `Date.now`
 * is stubbed and advanced by hand, the same technique
 * `hung-pane-session.test.ts` uses for its own multi-minute claims.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1001234";
const FLOOR_MS = 20;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function manager() {
  const { telegram, restore } = await installFakeTelegram();
  cleanups.push(restore);

  const db = new FakeSql();
  db.program("FROM chat_sessions", { rows: [] });
  // No operator message waiting — the branch that skips reopening entirely
  // is covered by `status-after-reply.test.ts`; this file is about the
  // branch where a reopen is attempted and fails.
  db.program("FROM message_queue", { rows: [] });

  const { StatusManager } = await import("../../channel/status.ts");
  const ctx: StatusContext = {
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => 1,
    sessionName: () => "helyx",
    projectName: "helyx",
    token: () => "fake-token",
  };

  const status = new StatusManager(ctx, { minEditIntervalMs: FLOOR_MS });
  cleanups.push(() => void status.deleteStatusMessage(CHAT));
  return { status, telegram };
}

/** A turn up to the point a continuation may reopen: opened, reported, replied, closed. */
async function upToTheReply(status: Awaited<ReturnType<typeof manager>>["status"]) {
  await status.sendStatusMessage(CHAT, "Thinking");
  await status.updateStatus(CHAT, "● Task: three explorers");
  status.noteReplySent(CHAT, 5000);
  await status.deleteStatusMessage(CHAT);
}

/** Stub `Date.now` for the duration of `fn`, restoring it even if `fn` throws. */
async function withFakeClock(fn: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  let t = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => t;
  try {
    await fn((ms) => { t += ms; });
  } finally {
    Date.now = realNow;
  }
}

describe("maybeReopen backoff — F-001", () => {
  test("a failing reopen does not retry on the very next poll tick", async () => {
    const { status, telegram } = await manager();
    await withFakeClock(async (advance) => {
      await upToTheReply(status);
      telegram.sendResult = () => ({ ok: false, messageId: null, errorBody: "boom" });

      advance(10);
      await status.updateStatus(CHAT, "● Explore: one");
      const sentAfterFirst = telegram.sent.length;
      expect(sentAfterFirst).toBeGreaterThan(0);

      // The exact pathology reported in production: the next tick, 2s later.
      advance(2_000);
      await status.updateStatus(CHAT, "● Explore: two");
      expect(telegram.sent.length).toBe(sentAfterFirst);

      // A tick 4s after the first — still inside the first backoff window —
      // also does not retry. ("retries every ~8 seconds for hours" was the
      // observed cadence precisely because nothing else was in the way.)
      advance(2_000);
      await status.updateStatus(CHAT, "● Explore: three");
      expect(telegram.sent.length).toBe(sentAfterFirst);
    });
  });

  test("the retry does resume once the backoff window has passed", async () => {
    const { status, telegram } = await manager();
    await withFakeClock(async (advance) => {
      await upToTheReply(status);
      telegram.sendResult = () => ({ ok: false, messageId: null, errorBody: "boom" });

      advance(10);
      await status.updateStatus(CHAT, "● Explore: one");
      const sentAfterFirst = telegram.sent.length;

      // Comfortably past any single backoff window this earns.
      advance(400_000);
      await status.updateStatus(CHAT, "● Explore: two");
      expect(telegram.sent.length).toBe(sentAfterFirst + 1);
    });
  });

  test("it gives up after repeated failures instead of retrying forever", async () => {
    const { status, telegram } = await manager();
    await withFakeClock(async (advance) => {
      await upToTheReply(status);
      telegram.sendResult = () => ({ ok: false, messageId: null, errorBody: "boom" });

      const sentBefore = telegram.sent.length;
      // Twelve ticks, each spaced far enough apart to clear whatever backoff
      // is currently in force — more than the retry cap, so if the cap did
      // not hold this would show twelve attempts, not fewer.
      for (let i = 0; i < 12; i++) {
        advance(400_000);
        await status.updateStatus(CHAT, `● Explore: attempt ${i}`);
      }

      const attempts = telegram.sent.length - sentBefore;
      expect(attempts).toBeGreaterThan(0);
      expect(attempts).toBeLessThan(12);

      // And it stays given up: more elapsed time alone does not resume it —
      // only a new reply (see the next test) does.
      advance(10_000_000);
      await status.updateStatus(CHAT, "● Explore: much later");
      expect(telegram.sent.length - sentBefore).toBe(attempts);
    });
  });

  test("a new reply resets the count, so the next turn gets its own attempts", async () => {
    const { status, telegram } = await manager();
    await withFakeClock(async (advance) => {
      await upToTheReply(status);
      telegram.sendResult = () => ({ ok: false, messageId: null, errorBody: "boom" });

      for (let i = 0; i < 12; i++) {
        advance(400_000);
        await status.updateStatus(CHAT, `● Explore: attempt ${i}`);
      }
      const sentAfterFirstTurn = telegram.sent.length;

      // A fresh reply — the given-up turn is over, and this one has made no
      // attempts of its own, so it is not skipped by the old turn's cap.
      status.noteReplySent(CHAT, 6000);
      telegram.sendResult = () => ({ ok: true, messageId: 42 });
      advance(10_000);
      await status.updateStatus(CHAT, "● Explore: new turn");

      expect(telegram.sent.length).toBe(sentAfterFirstTurn + 1);
    });
  });

  test("single-flight: two poll ticks racing in spend only one send", async () => {
    const { status, telegram } = await manager();
    await withFakeClock(async (advance) => {
      await upToTheReply(status);
      // `upToTheReply` itself sent the "Thinking" message — count from here.
      const sentBefore = telegram.sent.length;

      // Two ticks fired back to back, neither awaited before the other
      // starts — the shape a 2s monitor poll and a slow `acquireSendSlot`
      // produce in production. `updateStatus` runs synchronously up to its
      // first `await`, so by the time the second call's body starts running,
      // the first has already taken the single-flight guard if it takes it
      // before its own first `await` — which is exactly what closes the gap
      // `pendingSendGenerations`' orphan-delete used to have to paper over.
      advance(10);
      const p1 = status.updateStatus(CHAT, "● Explore: one");
      const p2 = status.updateStatus(CHAT, "● Explore: two");
      await Promise.all([p1, p2]);

      expect(telegram.sent.length).toBe(sentBefore + 1);
    });
  });
});

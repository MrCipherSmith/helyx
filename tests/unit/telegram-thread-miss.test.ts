import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sendTelegramMessage } from "../../channel/telegram.ts";
import { channelLogger } from "../../logger.ts";
import { createLocalAllowance, setSharedAllowanceForTests } from "../../utils/telegram-rate-budget.ts";

/**
 * The channel's send path must notice when an answer lands outside the topic it
 * was addressed to.
 *
 * Telegram does not reject a send into a deleted forum topic: it accepts it,
 * drops the thread and files the message in General. Nothing errored, nothing
 * logged, and a project's whole conversation quietly moved to the hub. These
 * tests drive the real `telegramRequest` with a stubbed transport and assert on
 * what the operator would see.
 */

const TOKEN = "test-token";
const CHAT = "-1003908750902";

let errors: Array<Record<string, unknown>>;
let realFetch: typeof fetch;
let realError: typeof channelLogger.error;
let restoreAllowance: () => void;
let testAllowance: ReturnType<typeof createLocalAllowance>;

/** Reply with whatever Telegram would have returned for this call. */
function stubTelegram(result: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  errors = [];
  realFetch = globalThis.fetch;
  realError = channelLogger.error;
  (channelLogger as any).error = (obj: unknown) => {
    errors.push((obj ?? {}) as Record<string, unknown>);
  };
  // This file drives the real telegramRequest, which defaults to the
  // priority lane of the rate budget (flow 064; utils/telegram-rate-budget.ts).
  // The production singleton talks to a real Postgres row on a ~5s lease
  // window and is shared across the whole `bun test` process — neither of
  // which this test cares about. Stand in an allowance that never runs out
  // instead.
  testAllowance = createLocalAllowance({ lease: async () => ({ granted: 1_000 }) });
  restoreAllowance = setSharedAllowanceForTests("priority", testAllowance);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (channelLogger as any).error = realError;
  testAllowance.stop();
  restoreAllowance();
});

describe("send into a forum topic", () => {
  test("thread echoed back — silence", async () => {
    stubTelegram({ message_id: 500, message_thread_id: 1158, is_topic_message: true });

    const res = await sendTelegramMessage(TOKEN, CHAT, "hi", { message_thread_id: 1158 });

    expect(res.ok).toBe(true);
    expect(res.messageId).toBe(500);
    expect(errors).toEqual([]);
  });

  test("deleted topic — accepted, no thread, reported as landing in General", async () => {
    stubTelegram({ message_id: 501 });

    const res = await sendTelegramMessage(TOKEN, CHAT, "hi", { message_thread_id: 1159 });

    // The send still succeeds — Telegram said ok, and pretending otherwise would
    // make the channel retry a message that was in fact delivered.
    expect(res.ok).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].requestedThread).toBe(1159);
    expect(errors[0].landedIn).toBe("General");
    expect(errors[0].messageId).toBe(501);
  });

  test("a different thread than the one asked for is reported too", async () => {
    stubTelegram({ message_id: 502, message_thread_id: 1, is_topic_message: true });

    await sendTelegramMessage(TOKEN, CHAT, "hi", { message_thread_id: 1159 });

    expect(errors).toHaveLength(1);
    expect(errors[0].landedIn).toBe(1);
  });

  test("no topic requested — nothing to miss", async () => {
    stubTelegram({ message_id: 503 });

    await sendTelegramMessage(TOKEN, CHAT, "hi");

    expect(errors).toEqual([]);
  });

  // Raised in review: the first version of this case called the fire-and-forget
  // `deleteTelegramMessage` and waited on `Bun.sleep(0)` for the logging to have
  // happened. The assertion held by timing rather than by sequence, and a change
  // that delayed the work by one more tick would have turned it into a false
  // pass. The guard it exercises — a result that carries no `message_id` — is
  // reachable from an awaited call, so it is tested from one.
  test("a response that is not a message is not mistaken for a miss", async () => {
    stubTelegram(true);

    const res = await sendTelegramMessage(TOKEN, CHAT, "hi", { message_thread_id: 1159 });

    expect(res.ok).toBe(true);
    expect(errors).toEqual([]);
  });
});

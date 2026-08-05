/**
 * `/now`, and the button that does ask the session.
 *
 * The card itself is covered in `session-snapshot.test.ts`; these are the two
 * behaviours that live in the command and nowhere else: pressing it again edits
 * the message it already sent, and the button queues a question the ordinary
 * way instead of inventing a delivery path that would jump the turn.
 *
 * Nothing here calls a model, opens a socket or reads the operator's real
 * `~/.claude`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Context } from "grammy";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { setNowDeps, handleNow, handleNowCallback, forgetCard, QUESTION, type NowDeps } from "../../bot/commands/now.ts";
import { NO_SESSION, type SessionSnapshot } from "../../utils/session-snapshot.ts";

const CHAT = "-1001234";
const TOPIC = 4242;

interface Said {
  replies: string[];
  toasts: string[];
}

let said: Said;
let db: FakeSql;
let restore: (() => void) | undefined;
let telegramRestore: (() => void) | undefined;
let telegram: Awaited<ReturnType<typeof installFakeTelegram>>["telegram"];
/** What routing says about this topic — a connected session unless a test says otherwise. */
let routed: Awaited<ReturnType<typeof import("../../sessions/router.ts").routeMessage>>;
/** What the record says — nothing, unless a test says otherwise. */
let snapshot: SessionSnapshot;

/** A chat that records what was said and hands out message ids like Telegram. */
function context(overrides: { callback?: boolean } = {}): Context {
  let nextId = 500;
  const base = {
    chat: { id: Number(CHAT) },
    from: { id: 1, username: "operator" },
    message: { message_thread_id: TOPIC },
    reply: async (text: string) => { said.replies.push(text); return { message_id: nextId++ }; },
    answerCallbackQuery: async (arg?: { text?: string }) => { said.toasts.push(arg?.text ?? ""); return true; },
  } as Record<string, unknown>;

  if (overrides.callback) {
    base.callbackQuery = { data: "now:ask", message: { message_thread_id: TOPIC } };
    base.message = undefined;
  }
  return base as unknown as Context;
}

beforeEach(async () => {
  said = { replies: [], toasts: [] };
  db = new FakeSql();
  // Routing finds a CLI session for this topic.
  db.program("FROM projects p", { rows: [{ path: "/home/altsay/bots/helyx", name: "helyx", session_id: 7, status: "connected", client_id: "c1", cli_config: {} }] });
  db.program("message_queue", { rows: [] });

  snapshot = NO_SESSION;
  routed = { mode: "cli", sessionId: 7, clientId: "c1", cliConfig: {}, projectPath: "/home/altsay/bots/helyx" } as typeof routed;

  const fake = await installFakeTelegram();
  telegram = fake.telegram;
  telegramRestore = fake.restore;

  const stubs: Partial<NowDeps> = {
    sql: db.sql as unknown as NowDeps["sql"],
    // The model is never called in a test; its absence is the case the card
    // must survive anyway.
    reading: async () => null,
    hasOpenQuestion: (async () => false) as unknown as NowDeps["hasOpenQuestion"],
    route: async () => routed,
    // Never the real ~/.claude: the first version of this test read this very
    // session's transcript and passed for the wrong reason.
    snapshot: async () => snapshot,
    now: () => 1_800_000_000_000,
  };
  restore = setNowDeps(stubs);
  forgetCard(CHAT, TOPIC);
});

afterEach(() => {
  restore?.();
  telegramRestore?.();
  restore = undefined;
  forgetCard(CHAT, TOPIC);
});

describe("the card", () => {
  test("answers without queueing anything", async () => {
    // The whole point: the question that used to cost a turn now costs a read.
    await handleNow(context());

    expect(said.replies).toHaveLength(1);
    expect(db.matching("message_queue")).toHaveLength(0);
  });

  test("a project with no transcript is answered, not errored", async () => {
    await handleNow(context());

    expect(said.replies[0]).toContain("не запущена");
  });

  test("what the record says is what the card says", async () => {
    snapshot = {
      found: true,
      lastLine: "● Read: channel/status.ts",
      agoMs: 12_000,
      tools: 7,
      files: 3,
      waiting: "working",
      agents: [{ label: "Explore", lastLine: "● [Explore] Grep: TODO", agoMs: null }],
    };

    await handleNow(context());

    expect(said.replies[0]).toContain("status.ts");
    expect(said.replies[0]).toContain("Explore");
    expect(said.replies[0]).toContain("работает");
  });

  test("pressing again edits the card instead of sending another", async () => {
    // The operator presses this when they are impatient, which is exactly when
    // they press it repeatedly. Ten presses must not be ten messages.
    await handleNow(context());
    await handleNow(context());

    expect(said.replies).toHaveLength(1);
    expect(telegram.edits.length).toBeGreaterThan(0);
  });

  test("a card that can no longer be edited is replaced rather than lost", async () => {
    // Deleted by hand, or too old for Telegram to edit. The operator asked a
    // question and must get an answer either way.
    await handleNow(context());
    telegram.editResult = () => ({ ok: false, errorBody: "message to edit not found" });

    await handleNow(context());

    expect(said.replies).toHaveLength(2);
  });
});

describe("the button that asks the session", () => {
  test("queues the question the ordinary way", async () => {
    // No second delivery path: the existing one is the only one that respects a
    // turn, and a question that jumped it would be answered about the wrong
    // thing.
    await handleNowCallback(context({ callback: true }));

    const queued = db.matching("message_queue");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.values).toContain(QUESTION);
    expect(said.toasts[0]).toContain("Спросил");
  });

  test("a chat with no session says so instead of queueing into nothing", async () => {
    routed = { mode: "standalone", sessionId: 0 } as typeof routed;

    await handleNowCallback(context({ callback: true }));

    expect(db.matching("message_queue")).toHaveLength(0);
    expect(said.toasts[0]).toContain("нет сессии");
  });
});

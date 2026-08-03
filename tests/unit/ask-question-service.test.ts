/**
 * The question path, end to end against a fake world.
 *
 * Driven through the service rather than its pieces, because the failure being
 * fixed is a gap *between* pieces: every part of the permission machinery
 * worked, and questions still never arrived, because nothing connected them.
 */

import { describe, test, expect } from "bun:test";
import {
  registerQuestions,
  waitForAnswers,
  recordAnswer,
  resolveTarget,
  hasOpenQuestion,
  type AskDeps,
} from "../../services/ask-question.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { HookInput, Question } from "../../utils/ask-question.ts";

const SELECT_TARGET = "FROM sessions s LEFT JOIN chat_sessions";
const INSERT_REQUEST = "INSERT INTO question_requests";
const SELECT_ANSWERS = "SELECT answers FROM question_requests";
const SELECT_ROW = "SELECT questions, answers, answered_at";
const UPDATE_ANSWERS = "UPDATE question_requests SET answers";

const QUESTIONS: Question[] = [
  { question: "Имя пакета?", options: [{ label: "scoped" }, { label: "переименовать" }] },
  { question: "Версия?", options: [{ label: "0.2.0" }, { label: "0.20.0" }] },
];

function hookInput(questions: Question[] = QUESTIONS): HookInput {
  return { sessionId: "claude-uuid", cwd: "/home/altsay/keryx", toolUseId: "toolu_1", questions };
}

interface World {
  db: FakeSql;
  sent: { chatId: string; text: string; extra: Record<string, unknown> }[];
  edits: { chatId: string; messageId: number; text: string }[];
  deps: AskDeps;
}

function makeWorld(options: { sendOk?: boolean } = {}): World {
  const db = new FakeSql();
  const sent: World["sent"] = [];
  const edits: World["edits"] = [];
  let nextMessageId = 700;

  // `sql.json` is a postgres.js helper the service uses for JSONB columns; the
  // fake has no such method, so it is supplied here and the value passes
  // through as an ordinary parameter.
  (db.sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  const deps: AskDeps = {
    sql: db.sql as never,
    sendMessage: async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
      return options.sendOk === false
        ? { ok: false, messageId: null }
        : { ok: true, messageId: nextMessageId++ };
    },
    editMessage: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
    },
    random: () => 0.5,
  };

  return { db, sent, edits, deps };
}

function withChat(world: World, row: Record<string, unknown> = {}) {
  world.db.program(SELECT_TARGET, {
    rows: [{ session_id: 42, chat_id: "-100123", forum_topic_id: null, forum_chat_id: null, ...row }],
  });
}

describe("resolveTarget", () => {
  test("a direct chat", async () => {
    const world = makeWorld();
    withChat(world);
    expect(await resolveTarget(world.deps.sql, { sessionId: "x", cwd: "/p" })).toEqual({
      sessionId: 42,
      chatId: "-100123",
      extra: {},
    });
  });

  test("a forum topic wins over the direct chat", async () => {
    const world = makeWorld();
    withChat(world, { forum_chat_id: "-100999", forum_topic_id: 12 });
    expect(await resolveTarget(world.deps.sql, { sessionId: "x", cwd: "/p" })).toEqual({
      sessionId: 42,
      chatId: "-100999",
      extra: { message_thread_id: 12 },
    });
  });

  test("a forum chat with no topic is not a target", async () => {
    // Half a forum configuration would send the question to the group's General
    // topic, where the project's operator is not looking.
    const world = makeWorld();
    withChat(world, { forum_chat_id: "-100999", forum_topic_id: null, chat_id: null });
    expect(await resolveTarget(world.deps.sql, { sessionId: "x", cwd: "/p" })).toBeNull();
  });

  test("no session for this directory means nowhere to send", async () => {
    const world = makeWorld();
    world.db.program(SELECT_TARGET, { rows: [] });
    expect(await resolveTarget(world.deps.sql, { sessionId: "x", cwd: "/p" })).toBeNull();
  });

  test("the lookup is by working directory, not by Claude's session id", async () => {
    // The id in the hook payload is Claude Code's own UUID; no column matches
    // it, and looking it up by that would find nothing every time.
    const world = makeWorld();
    withChat(world);
    await resolveTarget(world.deps.sql, { sessionId: "claude-uuid", cwd: "/home/altsay/keryx" });
    const query = world.db.matching(SELECT_TARGET)[0]!;
    expect(query.values).toContain("/home/altsay/keryx");
    expect(query.values).not.toContain("claude-uuid");
  });
});

describe("registerQuestions", () => {
  test("one message per question, each with a button per option", async () => {
    const world = makeWorld();
    withChat(world);

    const registered = await registerQuestions(world.deps, hookInput());

    expect(registered).not.toBeNull();
    expect(world.sent).toHaveLength(2);
    expect(world.sent[0]!.text).toContain("Имя пакета?");
    expect(world.sent[1]!.text).toContain("Версия?");
    const keyboard = (world.sent[0]!.extra.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard.flat();
    expect(keyboard.map((b) => b.callback_data)).toEqual([
      `ask:${registered!.requestId}:0:0`,
      `ask:${registered!.requestId}:0:1`,
    ]);
  });

  test("the row is written before the first message is sent", async () => {
    // A button pressed the moment it appears must find a row to write into,
    // and Telegram is quicker than a second round-trip to Postgres.
    const world = makeWorld();
    withChat(world);
    let insertSeenBeforeFirstSend = false;
    const deps: AskDeps = {
      ...world.deps,
      sendMessage: async (chatId, text, extra) => {
        insertSeenBeforeFirstSend ||= world.db.count(INSERT_REQUEST) > 0;
        world.sent.push({ chatId, text, extra });
        return { ok: true, messageId: 1 };
      },
    };

    await registerQuestions(deps, hookInput());

    expect(insertSeenBeforeFirstSend).toBe(true);
  });

  test("answers start empty, one slot per question", async () => {
    const world = makeWorld();
    withChat(world);

    await registerQuestions(world.deps, hookInput());

    const insert = world.db.matching(INSERT_REQUEST)[0]!;
    expect(insert.values[5]).toEqual([null, null]);
  });

  test("nowhere to send means nothing is registered", async () => {
    const world = makeWorld();
    world.db.program(SELECT_TARGET, { rows: [] });

    expect(await registerQuestions(world.deps, hookInput())).toBeNull();
    expect(world.db.count(INSERT_REQUEST)).toBe(0);
    expect(world.sent).toHaveLength(0);
  });

  test("if every send fails the request is withdrawn, not left to time out", async () => {
    // Waiting ten minutes for an answer to a message that never arrived is the
    // original bug wearing a different hat.
    const world = makeWorld({ sendOk: false });
    withChat(world);

    expect(await registerQuestions(world.deps, hookInput())).toBeNull();
    expect(world.db.count("DELETE FROM question_requests")).toBe(1);
  });
});

describe("recordAnswer", () => {
  function openRequest(world: World, answers: (number | null)[] = [null, null]) {
    world.db.program(SELECT_ROW, {
      rows: [
        {
          questions: QUESTIONS,
          answers,
          answered_at: null,
          chat_id: "-100123",
          message_ids: [700, 701],
        },
      ],
    });
  }

  test("a tapped button is written to its own slot", async () => {
    const world = makeWorld();
    openRequest(world);

    const outcome = await recordAnswer(world.deps, "ask:abcd1234:1:1");

    expect(outcome).toEqual({ status: "recorded", label: "0.20.0", complete: false });
    expect(world.db.matching(UPDATE_ANSWERS)[0]!.values[0]).toEqual([null, 1]);
  });

  test("complete only once every question has an answer", async () => {
    // The tool is one call: denying it after one of two answers would tell
    // Claude the other question had been declined.
    const world = makeWorld();
    openRequest(world, [0, null]);

    const outcome = await recordAnswer(world.deps, "ask:abcd1234:1:0");

    expect(outcome).toEqual({ status: "recorded", label: "0.2.0", complete: true });
  });

  test("choosing the first option counts — index zero is an answer", async () => {
    const world = makeWorld();
    openRequest(world, [null]);
    world.db.program(SELECT_ROW, {
      rows: [{ questions: [QUESTIONS[0]], answers: [null], answered_at: null, chat_id: "-1", message_ids: [700] }],
    });

    const outcome = await recordAnswer(world.deps, "ask:abcd1234:0:0");

    expect(outcome).toEqual({ status: "recorded", label: "scoped", complete: true });
  });

  test("the message is edited to show what was chosen", async () => {
    const world = makeWorld();
    openRequest(world);

    await recordAnswer(world.deps, "ask:abcd1234:0:1");

    expect(world.edits).toHaveLength(1);
    expect(world.edits[0]!.messageId).toBe(700);
    expect(world.edits[0]!.text).toContain("Выбрано: переименовать");
  });

  test("every refusal is its own outcome, never a silent no-op", async () => {
    // A button that does nothing and says nothing is the same experience as
    // the bug being fixed.
    const world = makeWorld();
    expect(await recordAnswer(world.deps, "perm:allow:x")).toEqual({ status: "not-ours" });

    world.db.program(SELECT_ROW, { rows: [] });
    expect(await recordAnswer(world.deps, "ask:gone:0:0")).toEqual({ status: "unknown" });

    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [0, 0], answered_at: new Date(), chat_id: "-1", message_ids: [] }],
    });
    expect(await recordAnswer(world.deps, "ask:done:0:0")).toEqual({ status: "already-answered" });

    openRequest(world);
    expect(await recordAnswer(world.deps, "ask:abcd1234:0:9")).toEqual({ status: "out-of-range" });
    expect(await recordAnswer(world.deps, "ask:abcd1234:9:0")).toEqual({ status: "out-of-range" });
  });

  test("an answered request is not rewritten by a late tap", async () => {
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [0, 0], answered_at: new Date(), chat_id: "-1", message_ids: [] }],
    });

    await recordAnswer(world.deps, "ask:done:0:1");

    expect(world.db.count(UPDATE_ANSWERS)).toBe(0);
  });
});

describe("waitForAnswers", () => {
  function ticker(start = 0) {
    let t = start;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }

  test("returns the answers once they are all in", async () => {
    const world = makeWorld();
    const clock = ticker();
    world.db.programSequence(SELECT_ANSWERS, [
      { rows: [{ answers: [null, null] }] },
      { rows: [{ answers: [1, null] }] },
      { rows: [{ answers: [1, 0] }] },
    ]);

    const answers = await waitForAnswers(
      { ...world.deps, now: clock.now, sleep: clock.sleep },
      "abcd1234",
      2,
      600_000,
    );

    expect(answers).toEqual([1, 0]);
    expect(world.db.count("SET answered_at = NOW()")).toBe(1);
  });

  test("a partial answer is not enough", async () => {
    const world = makeWorld();
    const clock = ticker();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [1, null] }] });

    const answers = await waitForAnswers(
      { ...world.deps, now: clock.now, sleep: clock.sleep },
      "abcd1234",
      2,
      5_000,
    );

    expect(answers).toBeNull();
  });

  test("timing out returns null, which is how the terminal keeps working", async () => {
    // Silence from the hook means Claude Code proceeds as though it had not
    // run: the selector is drawn and the terminal behaves exactly as before.
    const world = makeWorld();
    const clock = ticker();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [null] }] });

    expect(
      await waitForAnswers({ ...world.deps, now: clock.now, sleep: clock.sleep }, "abcd1234", 1, 3_000),
    ).toBeNull();
  });

  test("a vanished request stops the wait rather than running to the deadline", async () => {
    const world = makeWorld();
    const clock = ticker();
    world.db.program(SELECT_ANSWERS, { rows: [] });

    expect(
      await waitForAnswers({ ...world.deps, now: clock.now, sleep: clock.sleep }, "gone", 1, 600_000),
    ).toBeNull();
    expect(world.db.count(SELECT_ANSWERS)).toBe(1);
  });

  test("a stored answer that is not an option index is not an answer", async () => {
    // JSONB gives back whatever was stored. A string or a negative number here
    // would otherwise satisfy "all answered" and be handed to Claude as a choice.
    const world = makeWorld();
    const clock = ticker();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: ["1", -1] }] });

    expect(
      await waitForAnswers({ ...world.deps, now: clock.now, sleep: clock.sleep }, "abcd1234", 2, 3_000),
    ).toBeNull();
  });
});

describe("hasOpenQuestion", () => {
  test("true while a question is outstanding", async () => {
    const world = makeWorld();
    world.db.program("FROM question_requests", { rows: [{ "?column?": 1 }] });
    expect(await hasOpenQuestion(world.deps.sql, 42)).toBe(true);
  });

  test("false otherwise", async () => {
    const world = makeWorld();
    world.db.program("FROM question_requests", { rows: [] });
    expect(await hasOpenQuestion(world.deps.sql, 42)).toBe(false);
  });

  test("the query is bounded in time, so a stale row cannot mute the supervisor forever", async () => {
    const world = makeWorld();
    world.db.program("FROM question_requests", { rows: [] });
    await hasOpenQuestion(world.deps.sql, 42);
    expect(world.db.matching("FROM question_requests")[0]!.text).toContain("INTERVAL '15 minutes'");
  });
});

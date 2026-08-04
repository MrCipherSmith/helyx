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
  recordTypedAnswer,
  resolveTarget,
  hasOpenQuestion,
  cancelRequest,
  expireRequest,
  runQuestionExchange,
  type AskDeps,
} from "../../services/ask-question.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { HookInput, Question } from "../../utils/ask-question.ts";

const SELECT_TARGET = "FROM sessions s LEFT JOIN chat_sessions";
const INSERT_REQUEST = "INSERT INTO question_requests";
const SELECT_ANSWERS = "SELECT answers, expired_at FROM question_requests";
const SELECT_ROW = "SELECT questions, answers, answered_at";
const UPDATE_ANSWERS = "SET answers = jsonb_set";

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
  edits: { chatId: string; messageId: number; text: string; extra?: Record<string, unknown> }[];
  deps: AskDeps;
}

function makeWorld(options: { sendOk?: boolean; editOk?: boolean } = {}): World {
  const editResult = () => (options.editOk === false ? { ok: false } : { ok: true });
  const db = new FakeSql();
  const sent: World["sent"] = [];
  const edits: World["edits"] = [];
  let nextMessageId = 700;

  const deps: AskDeps = {
    sql: db.sql as never,
    sendMessage: async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
      return options.sendOk === false
        ? { ok: false, messageId: null }
        : { ok: true, messageId: nextMessageId++ };
    },
    editMessage: async (chatId, messageId, text, extra) => {
      edits.push({ chatId, messageId, text, extra });
      return editResult();
    },
    random: () => 0.5,
  };

  return { db, sent, edits, deps };
}

function withChat(world: World, row: Record<string, unknown> = {}) {
  world.db.program(SELECT_TARGET, {
    rows: [{ session_id: 42, chat_id: "-100123", forum_topic_id: null, forum_chat_id: null, ...row }],
  });
  // Recording each message id is part of the ordinary case: the write returns
  // the row it updated, and a write that matches nothing means the request is
  // gone, which registration treats as delivery failing.
  world.db.program("SET message_ids", { rows: [{ id: "ok" }] });
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
      `ask:${registered!.requestId}:0:t`,
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
    world.db.program("SET expired_at = NOW()", { rows: [{ chat_id: "-1", questions: QUESTIONS, message_ids: [null, null] }] });

    expect(await registerQuestions(world.deps, hookInput())).toBeNull();
    expect(world.db.count("SET expired_at = NOW()")).toBe(1);
  });

  test("a message that did land has its keyboard taken down when a later one fails", async () => {
    // Deleting the row would leave the first question sitting on the operator's
    // screen with live buttons and nothing behind them — the same complaint,
    // moved one step earlier.
    const world = makeWorld();
    withChat(world);
    let call = 0;
    const deps: AskDeps = {
      ...world.deps,
      sendMessage: async () => (++call === 1 ? { ok: true, messageId: 700 } : { ok: false, messageId: null }),
    };
    world.db.program("SET expired_at = NOW()", {
      rows: [{ chat_id: "-100123", questions: QUESTIONS, message_ids: [700, null] }],
    });

    expect(await registerQuestions(deps, hookInput())).toBeNull();

    expect(world.edits).toHaveLength(1);
    expect(world.edits[0]!.messageId).toBe(700);
    expect(world.edits[0]!.extra?.reply_markup).toEqual({ inline_keyboard: [] });
  });

  test("message ids are recorded as each one lands, not once at the end", async () => {
    // The cleanup has to be able to find a message that is already on screen
    // when the next send fails.
    const world = makeWorld();
    withChat(world);

    await registerQuestions(world.deps, hookInput());

    expect(world.db.count("SET message_ids")).toBe(2);
  });

  test("an id that cannot be persisted withdraws the call, retiring what did land", async () => {
    // The message exists and nothing stored can find it again. Leaving it would
    // put a live keyboard beyond the reach of every later cleanup — so the ids
    // this function still holds are handed to the expiry directly.
    const world = makeWorld();
    withChat(world);
    world.db.program("SET message_ids", { error: new Error("connection reset") });
    world.db.program("SET expired_at = NOW()", {
      rows: [{ chat_id: "-100123", questions: QUESTIONS, message_ids: [] }],
    });

    const realError = console.error;
    console.error = () => {};
    try {
      expect(await registerQuestions(world.deps, hookInput())).toBeNull();
    } finally {
      console.error = realError;
    }

    // The row knew nothing, and the keyboard still came down.
    expect(world.edits).toHaveLength(1);
    expect(world.edits[0]!.messageId).toBe(700);
    expect(world.edits[0]!.extra?.reply_markup).toEqual({ inline_keyboard: [] });
  });
});

describe("recordAnswer", () => {
  function openRequest(world: World, answers: (number | null)[] = [null, null], after?: (number | null)[]) {
    world.db.program(SELECT_ROW, {
      rows: [
        {
          questions: QUESTIONS,
          answers,
          answered_at: null,
          expired_at: null,
          chat_id: "-100123",
          message_ids: [700, 701],
        },
      ],
    });
    // The update returns the row as the database left it — that is the value
    // the outcome is computed from, not a local guess about what it became.
    world.db.program(UPDATE_ANSWERS, { rows: [{ answers: after ?? answers }] });
  }

  test("a tapped button is written to its own slot", async () => {
    const world = makeWorld();
    openRequest(world, [null, null], [null, 1]);

    const outcome = await recordAnswer(world.deps, "ask:abcd1234:1:1");

    expect(outcome).toEqual({ status: "recorded", label: "0.20.0", complete: false });
    // One slot, set by the database. Reading the array and writing it back
    // would lose an answer whenever two buttons are tapped at once.
    const update = world.db.matching(UPDATE_ANSWERS)[0]!;
    expect(update.text).toContain("jsonb_set");
    // The question index appears twice: once to place the answer, once to
    // clear this question's typing wait and no other's.
    expect(update.values).toEqual(["1", 1, 1, "abcd1234"]);
  });

  test("complete only once every question has an answer", async () => {
    // The tool is one call: denying it after one of two answers would tell
    // Claude the other question had been declined.
    const world = makeWorld();
    openRequest(world, [0, null], [0, 0]);

    const outcome = await recordAnswer(world.deps, "ask:abcd1234:1:0");

    expect(outcome).toEqual({ status: "recorded", label: "0.2.0", complete: true });
  });

  test("choosing the first option counts — index zero is an answer", async () => {
    const world = makeWorld();
    openRequest(world, [null]);
    world.db.program(SELECT_ROW, {
      rows: [{ questions: [QUESTIONS[0]], answers: [null], answered_at: null, expired_at: null, chat_id: "-1", message_ids: [700] }],
    });
    world.db.program(UPDATE_ANSWERS, { rows: [{ answers: [0] }] });

    const outcome = await recordAnswer(world.deps, "ask:abcd1234:0:0");

    expect(outcome).toEqual({ status: "recorded", label: "scoped", complete: true });
  });

  test("the message is edited to show what was chosen", async () => {
    const world = makeWorld();
    openRequest(world, [null, null], [1, null]);

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
      rows: [{ questions: QUESTIONS, answers: [0, 0], answered_at: new Date(), expired_at: null, chat_id: "-1", message_ids: [] }],
    });
    expect(await recordAnswer(world.deps, "ask:done:0:0")).toEqual({ status: "already-answered" });

    openRequest(world);
    expect(await recordAnswer(world.deps, "ask:abcd1234:0:9")).toEqual({ status: "out-of-range" });
    expect(await recordAnswer(world.deps, "ask:abcd1234:9:0")).toEqual({ status: "out-of-range" });
  });

  test("an answered request is not rewritten by a late tap", async () => {
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [0, 0], answered_at: new Date(), expired_at: null, chat_id: "-1", message_ids: [] }],
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
      { rows: [{ answers: [null, null], expired_at: null }] },
      { rows: [{ answers: [1, null], expired_at: null }] },
      { rows: [{ answers: [1, 0], expired_at: null }] },
    ]);
    // The claim on answered_at has to win, and the fake has to say so.
    world.db.program("SET answered_at = NOW()", { rows: [{ answers: [1, 0] }] });

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
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [1, null], expired_at: null }] });

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
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [null], expired_at: null }] });

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
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: ["1", -1], expired_at: null }] });

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


describe("partial delivery is not delivery", () => {
  test("one failed send withdraws the whole request", async () => {
    // The worst outcome available: the questions that arrived can be answered,
    // the one that did not never can, so the call never completes — and the
    // terminal selector stays suppressed for the full ten minutes.
    const world = makeWorld();
    withChat(world);
    world.db.program("SET expired_at = NOW()", { rows: [{ chat_id: "-1", questions: QUESTIONS, message_ids: [700, null] }] });
    let call = 0;
    const deps: AskDeps = {
      ...world.deps,
      sendMessage: async () => (++call === 1 ? { ok: true, messageId: 700 } : { ok: false, messageId: null }),
    };

    expect(await registerQuestions(deps, hookInput())).toBeNull();
    // Expired rather than deleted: the message that did land keeps a live
    // keyboard until something takes it down.
    expect(world.db.count("SET expired_at = NOW()")).toBe(1);
  });

  test("a send that succeeds without a message id counts as failed", async () => {
    // No message id means no message to edit and nothing to point a button at.
    const world = makeWorld();
    withChat(world);
    const deps: AskDeps = { ...world.deps, sendMessage: async () => ({ ok: true, messageId: null }) };

    expect(await registerQuestions(deps, hookInput())).toBeNull();
  });
});

describe("expiry", () => {
  function ticker(start = 0) {
    let t = start;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }

  test("timing out marks the request expired", async () => {
    // Otherwise the buttons still on the operator's screen keep claiming they
    // can be answered, while nothing is listening.
    const world = makeWorld();
    const clock = ticker();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [null], expired_at: null }] });

    await waitForAnswers({ ...world.deps, now: clock.now, sleep: clock.sleep }, "abcd1234", 1, 3_000);

    expect(world.db.count("SET expired_at = NOW()")).toBe(1);
  });

  test("a request expired elsewhere ends the wait", async () => {
    // The client hung up and the endpoint cancelled it; polling on would hold a
    // connection nobody is reading.
    const world = makeWorld();
    const clock = ticker();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [null], expired_at: new Date() }] });

    expect(
      await waitForAnswers({ ...world.deps, now: clock.now, sleep: clock.sleep }, "abcd1234", 1, 600_000),
    ).toBeNull();
    expect(world.db.count(SELECT_ANSWERS)).toBe(1);
  });

  test("a tap after expiry is refused rather than reported as sent", async () => {
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [null, null], answered_at: null, expired_at: new Date(), chat_id: "-1", message_ids: [] }],
    });

    expect(await recordAnswer(world.deps, "ask:abcd1234:0:0")).toEqual({ status: "expired" });
    expect(world.db.count(UPDATE_ANSWERS)).toBe(0);
  });

  test("answering guards against a concurrent cancel", async () => {
    // The two terminal states are exclusive. Without the guard a request
    // cancelled at the same moment could end up both answered and expired, and
    // the callback would report a send to a waiter that had already gone.
    const world = makeWorld();
    const clock = { now: () => 0, sleep: async () => {} };
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [0], expired_at: null }] });

    await waitForAnswers({ ...world.deps, ...clock }, "abcd1234", 1, 600_000);

    const update = world.db.matching("SET answered_at = NOW()")[0]!;
    expect(update.text).toContain("expired_at IS NULL");
  });

  test("a row carrying both states is reported as expired, not as answered", async () => {
    // Should not happen, and if it ever does, "no longer waiting" is the true
    // thing to say.
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [0, 0], answered_at: new Date(), expired_at: new Date(), chat_id: "-1", message_ids: [] }],
    });

    expect(await recordAnswer(world.deps, "ask:abcd1234:0:0")).toEqual({ status: "expired" });
  });

  test("cancelRequest only touches a request still waiting", async () => {
    const world = makeWorld();
    await cancelRequest(world.deps, "abcd1234");
    const update = world.db.matching("SET expired_at = NOW()")[0]!;
    expect(update.text).toContain("answered_at IS NULL");
    expect(update.text).toContain("expired_at IS NULL");
  });

  test("expiring takes the buttons down and says why", async () => {
    // The complaint this fixes: an operator taps a question ten minutes old,
    // is told it is no longer waiting, and had no way to know that before
    // tapping. The hook cannot warn them — it cannot tell either — so the
    // message says so when the wait ends.
    const world = makeWorld();
    world.db.program("SET expired_at = NOW()", {
      rows: [{ chat_id: "-100123", questions: QUESTIONS, message_ids: [700, 701] }],
    });

    await expireRequest(world.deps, "abcd1234");

    expect(world.edits).toHaveLength(2);
    expect(world.edits[0]!.text).toContain("больше не ждёт ответа");
    expect(world.edits[0]!.extra?.reply_markup).toEqual({ inline_keyboard: [] });
  });

  test("a request already settled is left alone", async () => {
    // The update claims nothing, so there is no live keyboard of ours to take
    // down — and editing an answered question back to "expired" would be a lie.
    const world = makeWorld();
    world.db.program("SET expired_at = NOW()", { rows: [] });

    await expireRequest(world.deps, "abcd1234");

    expect(world.edits).toHaveLength(0);
  });
});

describe("the atomic write", () => {
  test("the update refuses a request already answered or expired", async () => {
    // The guard lives in the statement, not in the read before it: between the
    // read and the write another tap can land.
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [null, null], answered_at: null, expired_at: null, chat_id: "-1", message_ids: [] }],
    });
    world.db.program(UPDATE_ANSWERS, { rows: [] });
    world.db.program("SELECT answered_at, expired_at FROM", { rows: [{ answered_at: new Date(), expired_at: null }] });

    expect(await recordAnswer(world.deps, "ask:abcd1234:0:0")).toEqual({ status: "already-answered" });
  });

  test("completeness is read back from the database, not computed locally", async () => {
    // Two taps at once: this one sets slot 0, the other set slot 1 a moment
    // earlier. Only the row knows both.
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [null, null], answered_at: null, expired_at: null, chat_id: "-1", message_ids: [] }],
    });
    world.db.program(UPDATE_ANSWERS, { rows: [{ answers: [0, 1] }] });

    expect(await recordAnswer(world.deps, "ask:abcd1234:0:0")).toEqual({
      status: "recorded",
      label: "scoped",
      complete: true,
    });
  });
});


describe("who wins the race decides what the operator is told", () => {
  test("a tap that loses to a cancel is reported as expired, not as answered", async () => {
    // The guarded update matched nothing. "Already answered" and "no longer
    // waiting" are different messages, and guessing gets it wrong exactly when
    // the race is real — so the state that won is read.
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [null, null], answered_at: null, expired_at: null, chat_id: "-1", message_ids: [] }],
    });
    world.db.program(UPDATE_ANSWERS, { rows: [] });
    world.db.program("SELECT answered_at, expired_at FROM", { rows: [{ answered_at: null, expired_at: new Date() }] });

    expect(await recordAnswer(world.deps, "ask:abcd1234:0:0")).toEqual({ status: "expired" });
  });

  test("a tap that loses to another answer is reported as answered", async () => {
    const world = makeWorld();
    world.db.program(SELECT_ROW, {
      rows: [{ questions: QUESTIONS, answers: [null, null], answered_at: null, expired_at: null, chat_id: "-1", message_ids: [] }],
    });
    world.db.program(UPDATE_ANSWERS, { rows: [] });
    world.db.program("SELECT answered_at, expired_at FROM", { rows: [{ answered_at: new Date(), expired_at: null }] });

    expect(await recordAnswer(world.deps, "ask:abcd1234:0:0")).toEqual({ status: "already-answered" });
  });

  test("a wait whose claim loses to a cancel returns nothing", async () => {
    // Returning the answers anyway would hand Claude a choice the operator had
    // already been told expired.
    const world = makeWorld();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [0], expired_at: null }] });
    world.db.program("SET answered_at = NOW()", { rows: [] });

    expect(
      await waitForAnswers({ ...world.deps, now: () => 0, sleep: async () => {} }, "abcd1234", 1, 600_000),
    ).toBeNull();
  });

  test("a wait whose claim wins returns the answers", async () => {
    const world = makeWorld();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [0], expired_at: null }] });
    world.db.program("SET answered_at = NOW()", { rows: [{ answers: [0] }] });

    expect(
      await waitForAnswers({ ...world.deps, now: () => 0, sleep: async () => {} }, "abcd1234", 1, 600_000),
    ).toEqual([0]);
  });
});

describe("runQuestionExchange — the ordering that was wrong twice", () => {
  test("a client that leaves while the questions are being sent cancels the request", async () => {
    // Starting a ten-minute wait for a reader that has already gone is the
    // exact shape of the original bug.
    const world = makeWorld();
    withChat(world);
    let gone = false;
    const deps: AskDeps = {
      ...world.deps,
      sendMessage: async (chatId, text, extra) => {
        // The hook's curl gives up mid-registration.
        gone = true;
        world.sent.push({ chatId, text, extra });
        return { ok: true, messageId: 700 + world.sent.length };
      },
    };

    const answers = await runQuestionExchange(deps, hookInput(), {
      timeoutMs: 600_000,
      clientGone: () => gone,
    });

    expect(answers).toBeNull();
    expect(world.db.count("SET expired_at = NOW()")).toBe(1);
    // And no wait was started.
    expect(world.db.count(SELECT_ANSWERS)).toBe(0);
  });

  test("a client still there gets the wait", async () => {
    const world = makeWorld();
    withChat(world);
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [0, 1], expired_at: null }] });
    world.db.program("SET answered_at = NOW()", { rows: [{ answers: [0, 1] }] });

    const answers = await runQuestionExchange(world.deps, hookInput(), {
      timeoutMs: 600_000,
      clientGone: () => false,
    });

    expect(answers).toEqual([0, 1]);
  });

  test("a client that leaves mid-wait cancels rather than holding its slot", async () => {
    // The check has to be inside the loop. Checked only before it, a curl that
    // gives up while the operator is deciding leaves the request polling for
    // the full ten minutes — and enough of those fill the waiter cap, after
    // which no question reaches Telegram at all.
    const world = makeWorld();
    withChat(world);
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [null, null], expired_at: null }] });
    let polls = 0;
    let t = 0;

    const answers = await runQuestionExchange(
      { ...world.deps, now: () => t, sleep: async (ms: number) => { t += ms; polls++; } },
      hookInput(),
      { timeoutMs: 600_000, pollMs: 1_000, clientGone: () => polls >= 2 },
    );

    expect(answers).toBeNull();
    expect(world.db.count("SET expired_at = NOW()")).toBe(1);
    // It stopped where the client left, not at the deadline.
    expect(polls).toBeLessThan(5);
  });

  test("nowhere to send means no wait and no cancel", async () => {
    const world = makeWorld();
    world.db.program(SELECT_TARGET, { rows: [] });

    expect(
      await runQuestionExchange(world.deps, hookInput(), { timeoutMs: 600_000, clientGone: () => false }),
    ).toBeNull();
    expect(world.db.count(SELECT_ANSWERS)).toBe(0);
    expect(world.db.count("SET expired_at = NOW()")).toBe(0);
  });
});


describe("what Claude receives is what the row committed", () => {
  test("a tap landing between the read and the claim wins", async () => {
    // The answers are read, then claimed. A second tap in between changes a
    // slot — and returning the earlier snapshot would hand Claude one option
    // while the row, and the message the operator is looking at, record another.
    const world = makeWorld();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [0, 0], expired_at: null }] });
    world.db.program("SET answered_at = NOW()", { rows: [{ answers: [0, 1] }] });

    expect(
      await waitForAnswers({ ...world.deps, now: () => 0, sleep: async () => {} }, "abcd1234", 2, 600_000),
    ).toEqual([0, 1]);
  });

  test("a claim that commits something unusable falls back to the terminal", async () => {
    // Handing Claude "(no answer)" for a slot is worse than asking again.
    //
    // The unusable value used to be a string. Since typed answers landed, a
    // string *is* an answer — so this now uses something that is genuinely
    // neither: an object, which no path can have written and no reader can
    // turn into words or an index.
    const world = makeWorld();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [0], expired_at: null }] });
    world.db.program("SET answered_at = NOW()", { rows: [{ answers: [{ nonsense: true }] }] });

    expect(
      await waitForAnswers({ ...world.deps, now: () => 0, sleep: async () => {} }, "abcd1234", 1, 600_000),
    ).toBeNull();
  });
});


describe("a failed edit is reported, not swallowed", () => {
  test("Telegram declining the edit is retried and then logged", async () => {
    // The row is already claimed, so this is the only chance to take the
    // keyboard down. Swallowing the failure leaves it live for good — which is
    // exactly the state being fixed — and says so nowhere.
    const world = makeWorld({ editOk: false });
    world.db.program("SET expired_at = NOW()", {
      rows: [{ chat_id: "-100123", questions: [QUESTIONS[0]], message_ids: [700] }],
    });

    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await expireRequest(world.deps, "abcd1234");
    } finally {
      console.error = realError;
    }

    // Attempted twice before giving up.
    expect(world.edits).toHaveLength(2);
    expect(String(errors.at(-1)?.[0] ?? "")).toContain("stays live");
  });

  test("an edit that throws counts as a failure too", async () => {
    const world = makeWorld();
    world.db.program("SET expired_at = NOW()", {
      rows: [{ chat_id: "-1", questions: [QUESTIONS[0]], message_ids: [700] }],
    });
    let attempts = 0;
    const deps: AskDeps = {
      ...world.deps,
      editMessage: async () => { attempts++; throw new Error("network"); },
    };

    const realError = console.error;
    console.error = () => {};
    try {
      await expireRequest(deps, "abcd1234");
    } finally {
      console.error = realError;
    }

    expect(attempts).toBe(2);
  });
});

describe("an answer the operator types", () => {
  const QUESTIONS = [{ question: "Куда деплоить?", multiSelect: false, options: [{ label: "staging" }] }];

  /** A request that has been told to expect words for question 0. */
  function awaiting(world: World, row: Record<string, unknown> = {}) {
    world.db.program("awaiting_question IS NOT NULL", {
      rows: [{ id: "req1", questions: QUESTIONS, awaiting_question: 0, ...row }],
    });
    world.db.program("SET answers = jsonb_set", { rows: [{ answers: ["на прод"] }] });
  }

  test("pressing the button marks the question as waiting, without answering it", async () => {
    // Nothing is recorded by the press. The answer is the message that
    // follows, and saying otherwise would close the call on an empty slot.
    const world = makeWorld();
    world.db.program("SELECT questions, answers", { rows: [{ questions: QUESTIONS, answers: [], chat_id: "-100", message_ids: [700] }] });
    world.db.program("SET awaiting_question", { rows: [{ id: "req1" }] });

    const outcome = await recordAnswer(world.deps, "ask:req1:0:t");

    expect(outcome.status).toBe("awaiting-text");
    expect(world.db.count("SET awaiting_question")).toBe(1);
    expect(world.db.count("SET answers = jsonb_set")).toBe(0);
  });

  test("the next message becomes the answer", async () => {
    const world = makeWorld();
    awaiting(world);

    const outcome = await recordTypedAnswer(world.deps, "-100", "на прод");

    expect(outcome).toEqual({ status: "recorded", label: "на прод", complete: true });
  });

  test("and stops the question waiting", async () => {
    // Left set, the operator's *next* message would be eaten as an answer to
    // a question already answered.
    const world = makeWorld();
    awaiting(world);

    await recordTypedAnswer(world.deps, "-100", "на прод");

    expect(world.db.matching("SET answers = jsonb_set")[0]!.text).toContain("awaiting_question = NULL");
  });

  test("a message with nothing waiting is not an answer", async () => {
    // The ordinary case, and the one that must stay ordinary: null tells the
    // caller to treat the message exactly as it always did.
    const world = makeWorld();
    world.db.program("awaiting_question IS NOT NULL", { rows: [] });

    expect(await recordTypedAnswer(world.deps, "-100", "просто сообщение")).toBeNull();
  });

  test("an empty message is refused and the question keeps waiting", async () => {
    // Accepting it would close the whole call with nothing in it: the operator
    // said nothing while Claude was told they had.
    const world = makeWorld();
    awaiting(world);

    const outcome = await recordTypedAnswer(world.deps, "-100", "   \n  ");

    expect(outcome!.status).toBe("out-of-range");
    expect(world.db.count("SET answers = jsonb_set")).toBe(0);
  });

  test("a request that ended between the press and the message is refused", async () => {
    // The waiter is gone; telling the operator their words were sent would be
    // a lie, and they would not retype them.
    const world = makeWorld();
    awaiting(world);
    world.db.program("SET answers = jsonb_set", { rows: [] });
    world.db.program("SELECT answered_at, expired_at", { rows: [{ answered_at: null, expired_at: new Date() }] });

    expect((await recordTypedAnswer(world.deps, "-100", "на прод"))!.status).toBe("expired");
  });

  test("the answer is stored as words, not as an index", async () => {
    // Stored as a number it would be read back as an option — and option "на
    // прод" does not exist, so the answer would vanish into out-of-range.
    const world = makeWorld();
    awaiting(world);

    await recordTypedAnswer(world.deps, "-100", "на прод");

    const values = world.db.matching("SET answers = jsonb_set")[0]!.values;
    expect(values).toContain("на прод");
  });

  test("the newest waiting request wins when there are two", async () => {
    // Ordered by creation: the operator is answering the question they were
    // just shown, not one they left open earlier.
    const world = makeWorld();
    awaiting(world);

    await recordTypedAnswer(world.deps, "-100", "на прод");

    expect(world.db.matching("awaiting_question IS NOT NULL")[0]!.text).toContain("ORDER BY created_at DESC");
  });
});

describe("the waiting marker is cleared by everything that ends the wait", () => {
  const QUESTIONS = [{ question: "Куда?", multiSelect: false, options: [{ label: "staging" }] }];

  test("choosing an option clears its own question's wait", async () => {
    // The operator can press "Свой ответ", change their mind and tap an
    // option. Left set, their next ordinary message would overwrite the option
    // they just chose and be swallowed on the way.
    const world = makeWorld();
    world.db.program("SELECT questions, answers", { rows: [{ questions: QUESTIONS, answers: [], chat_id: "-100", message_ids: [700] }] });
    world.db.program("SET answers = jsonb_set", { rows: [{ answers: [0] }] });

    await recordAnswer(world.deps, "ask:req1:0:0");

    const written = world.db.matching("SET answers = jsonb_set")[0]!.text;
    expect(written).toContain("awaiting_question");
  });

  test("but not another question's", async () => {
    // Two questions, one of them typing: answering the other must not cancel
    // the wait the operator is in the middle of.
    const world = makeWorld();
    world.db.program("SELECT questions, answers", { rows: [{ questions: [QUESTIONS[0], QUESTIONS[0]], answers: [], chat_id: "-100", message_ids: [700, 701] }] });
    world.db.program("SET answers = jsonb_set", { rows: [{ answers: [null, 0] }] });

    await recordAnswer(world.deps, "ask:req1:1:0");

    const query = world.db.matching("SET answers = jsonb_set")[0]!;
    expect(query.text).toContain("CASE WHEN awaiting_question");
    expect(query.values).toContain(1);
  });

  test("claiming the answers clears it", async () => {
    // Otherwise the marker outlives the request, and the operator's next
    // message is eaten by a question that is already closed.
    const world = makeWorld();
    world.db.program(SELECT_ANSWERS, { rows: [{ answers: [0], expired_at: null }] });
    world.db.program("SET answered_at = NOW()", { rows: [{ answers: [0] }] });

    await waitForAnswers({ ...world.deps, now: () => 0, sleep: async () => {} }, "abcd1234", 1, 600_000);

    expect(world.db.matching("SET answered_at = NOW()")[0]!.text).toContain("awaiting_question = NULL");
  });

  test("expiring clears it too", async () => {
    const world = makeWorld();
    world.db.program("SET expired_at = NOW()", { rows: [{ chat_id: "-100", questions: QUESTIONS, message_ids: [700] }] });

    await expireRequest(world.deps, "abcd1234");

    expect(world.db.matching("SET expired_at = NOW()")[0]!.text).toContain("awaiting_question = NULL");
  });
});

describe("a typed answer belongs to the topic it was typed in", () => {
  const QUESTIONS = [{ question: "Куда?", multiSelect: false, options: [{ label: "staging" }] }];

  test("the project scopes the lookup", async () => {
    // In a forum every topic shares one chat id. Matching on chat alone let
    // words typed in one project's topic answer — and consume — a question
    // waiting in another's: the operator answers a question they never saw,
    // and the one in front of them is still waiting.
    const world = makeWorld();
    world.db.program("awaiting_question IS NOT NULL", {
      rows: [{ id: "req1", questions: QUESTIONS, awaiting_question: 0 }],
    });
    world.db.program("SET answers = jsonb_set", { rows: [{ answers: ["на прод"] }] });

    await recordTypedAnswer(world.deps, "-100", "на прод", { kind: "project", path: "/home/altsay/bots/helyx" });

    const query = world.db.matching("awaiting_question IS NOT NULL")[0]!;
    expect(query.text).toContain("project_path");
    expect(query.values).toContain("/home/altsay/bots/helyx");
  });

  test("a direct message has no project and matches on the chat alone", async () => {
    // Outside a forum there is one conversation and no topic to scope by;
    // requiring a project there would answer nothing at all.
    const world = makeWorld();
    world.db.program("awaiting_question IS NOT NULL", {
      rows: [{ id: "req1", questions: QUESTIONS, awaiting_question: 0 }],
    });
    world.db.program("SET answers = jsonb_set", { rows: [{ answers: ["на прод"] }] });

    const outcome = await recordTypedAnswer(world.deps, "-100", "на прод", { kind: "chat" });

    expect(outcome!.status).toBe("recorded");
    expect(world.db.matching("awaiting_question IS NOT NULL")[0]!.values).toContain(null);
  });


  test("the request records the project it belongs to", async () => {
    // What scopes a typed answer later. Stored as the hook's working
    // directory and compared against `projects.path`, which is the same
    // equality `resolveTarget` already depends on — so if the two ever drift,
    // they drift together rather than only here.
    const world = makeWorld();
    withChat(world);

    await registerQuestions(world.deps, hookInput());

    const insert = world.db.matching("INSERT INTO question_requests")[0]!;
    expect(insert.text).toContain("project_path");
    expect(insert.values).toContain("/home/altsay/keryx");
  });

  test("a topic whose project cannot be resolved answers nothing", async () => {
    // Not "no scope" but "scope unknown". Treated as no scope, an unmapped
    // topic — or a lookup that simply failed — would consume whichever
    // question in the whole forum happened to be newest, and the operator who
    // was waiting on it would never be told.
    const world = makeWorld();
    world.db.program("awaiting_question IS NOT NULL", {
      rows: [{ id: "req1", questions: QUESTIONS, awaiting_question: 0 }],
    });

    const outcome = await recordTypedAnswer(world.deps, "-100", "на прод", { kind: "unresolved" });

    expect(outcome).toBeNull();
    // And it did not even look: a query here is a question that could match.
    expect(world.db.count("awaiting_question IS NOT NULL")).toBe(0);
  });
});

describe("toggling and submitting a multi-select question", () => {
  const MULTI = [{ question: "Что включить?", multiSelect: true, options: [{ label: "тесты" }, { label: "линт" }] }];

  function open(world: World, answers: unknown[] = [], after: unknown[] = []) {
    world.db.program("SELECT questions, answers", {
      rows: [{ questions: MULTI, answers, chat_id: "-100", message_ids: [700] }],
    });
    world.db.program("SET answers = jsonb_set", { rows: [{ answers: after }] });
  }

  test("a tap adds the option and does not answer the question", async () => {
    // Toggling is not answering: the call must keep waiting until the operator
    // says they are done, or the first tap becomes the whole answer.
    const world = makeWorld();
    open(world, [], [{ picked: [0], done: false }]);

    const outcome = await recordAnswer(world.deps, "ask:req1:0:0");

    expect(outcome.status).toBe("toggled");
    expect(world.db.count("SET answered_at = NOW()")).toBe(0);
  });

  test("the toggle happens in the database, not in this process", async () => {
    // Read the array here, change it and write it back, and two taps landing
    // together lose one — each write carrying the other's selection as it was
    // before it. The single-select path is careful about exactly this.
    const world = makeWorld();
    open(world, [], [{ picked: [0], done: false }]);

    await recordAnswer(world.deps, "ask:req1:0:0");

    const sql = world.db.matching("SET answers = jsonb_set")[0]!.text;
    expect(sql).toContain("jsonb_build_object");
    expect(sql).toContain("CASE");
  });

  test("tapping a chosen option removes it", async () => {
    const world = makeWorld();
    open(world, [{ picked: [0, 1], done: false }], [{ picked: [1], done: false }]);

    const outcome = await recordAnswer(world.deps, "ask:req1:0:0");

    expect(outcome).toEqual({ status: "toggled", label: "линт", picked: 1 });
  });

  test("the message is redrawn so the toggles show the set", async () => {
    // The only place the operator can see what they have chosen so far.
    const world = makeWorld();
    open(world, [], [{ picked: [1], done: false }]);

    await recordAnswer(world.deps, "ask:req1:0:0");

    const edit = world.edits.at(-1)!;
    expect(edit.text).toContain("Что включить?");
    const keyboard = (edit.extra!.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.flat();
    expect(keyboard[1]!.text).toContain("☑");
  });

  test("submitting closes the question and names what was chosen", async () => {
    const world = makeWorld();
    open(world, [{ picked: [0, 1], done: false }], [{ picked: [0, 1], done: true }]);

    const outcome = await recordAnswer(world.deps, "ask:req1:0:s");

    expect(outcome).toEqual({ status: "recorded", label: "тесты, линт", complete: true });
  });

  test("submitting nothing is refused and the question keeps waiting", async () => {
    // An empty submit would close it with nothing in it. "None of these" is a
    // real answer, but it belongs to the free-text button.
    const world = makeWorld();
    open(world, [{ picked: [], done: false }]);

    const outcome = await recordAnswer(world.deps, "ask:req1:0:s");

    expect(outcome.status).toBe("out-of-range");
    expect(world.db.count("SET answers = jsonb_set")).toBe(0);
  });

  test("a submitted set counts as answered", async () => {
    // The bug this shape exists to avoid: stored and then read back as
    // nothing, so the call never completes while the row holds the answer.
    const world = makeWorld();
    open(world, [{ picked: [0], done: false }], [{ picked: [0], done: true }]);

    expect((await recordAnswer(world.deps, "ask:req1:0:s")) as { complete?: boolean }).toHaveProperty("complete", true);
  });

  test("a single-select question is untouched by any of this", async () => {
    // One tap is still one answer, written as an index.
    const world = makeWorld();
    world.db.program("SELECT questions, answers", {
      rows: [{ questions: [{ question: "Куда?", multiSelect: false, options: [{ label: "staging" }] }], answers: [], chat_id: "-100", message_ids: [700] }],
    });
    world.db.program("SET answers = jsonb_set", { rows: [{ answers: [0] }] });

    const outcome = await recordAnswer(world.deps, "ask:req1:0:0");

    expect(outcome).toEqual({ status: "recorded", label: "staging", complete: true });
    expect(world.db.matching("SET answers = jsonb_set")[0]!.text).not.toContain("jsonb_build_object");
  });

  test("a tap on an expired request is refused", async () => {
    const world = makeWorld();
    open(world, [], []);
    world.db.program("SET answers = jsonb_set", { rows: [] });
    world.db.program("SELECT answered_at, expired_at", { rows: [{ answered_at: null, expired_at: new Date() }] });

    expect((await recordAnswer(world.deps, "ask:req1:0:0")).status).toBe("expired");
  });
});

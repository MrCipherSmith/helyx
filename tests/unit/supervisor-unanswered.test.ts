/**
 * Loop 7 — the guard that puts a lost message back on the queue.
 *
 * This is the mechanism behind the incident recorded in project memory as a
 * reply being lost when the guard fired, and until now it had no test at all.
 *
 * Its query is long and its decisions are short, and the decisions are the part
 * worth pinning: a dedup window, a reaction set on the original message, and a
 * refusal to re-queue anything already marked as re-queued. The order they
 * happen in is not arbitrary — the mark is what stops this loop and the
 * channel's own guard from handing the same question back and forth — so the
 * order is what these tests assert.
 *
 * Every assertion here is about an effect: a row inserted, a request posted, a
 * reaction set. The loop swallows its own exceptions in a `catch` that only
 * logs, so "it did not throw" is equally true of a function that did nothing.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { checkUnansweredMessages } from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { markRequeued } from "../../utils/requeue.ts";

const SELECT_UNANSWERED = "FROM sessions s JOIN messages m";
const INSERT_QUEUE = "INSERT INTO message_queue";
const REACTION = "setMessageReaction";
const SEND = "sendMessage";

let http: FakeFetch;
let restore: () => void;

beforeEach(() => {
  ({ http, restore } = installFakeFetch());
  http.program("api.telegram.org", { json: { ok: true, result: { message_id: 1 } } });
});

afterEach(() => restore());

/**
 * A distinct session per test.
 *
 * The dedup map is module state keyed by session and chat, so two tests sharing
 * an id would silence each other — and the second would pass for a reason its
 * author never chose.
 */
let nextSessionId = 8000;

function unansweredRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: nextSessionId,
    project: "helyx",
    msg_id: 55,
    chat_id: "-100123",
    content: "почему упало?",
    created_at: new Date(Date.now() - 20 * 60_000),
    age_sec: 1200,
    from_user: "altsay",
    telegram_msg_id: 4242,
    ...overrides,
  };
}

function worldWith(row: Record<string, unknown>) {
  nextSessionId++;
  const db = new FakeSql();
  const seeded = { ...unansweredRow(), session_id: nextSessionId, ...row };
  db.program(SELECT_UNANSWERED, { rows: [seeded] });
  return { db, row: seeded };
}

describe("a message that has gone unanswered is put back", () => {
  test("the re-injected row is undelivered, marked, and keeps the telegram message id", async () => {
    const { db, row } = worldWith({});

    await checkUnansweredMessages(db.sql as never);

    const inserts = db.matching(INSERT_QUEUE);
    expect(inserts).toHaveLength(1);

    const [sessionId, chatId, fromUser, content, telegramMsgId] = inserts[0]!.values;
    expect(sessionId).toBe(row.session_id);
    expect(chatId).toBe("-100123");
    expect(fromUser).toBe("altsay");
    // The mark is what the channel's own guard recognises. Without it the two
    // paths hand the same question back and forth.
    expect(String(content)).toStartWith("[♻️");
    expect(String(content)).toContain("почему упало?");
    // Carried through so the reply tool can tick the original message when an
    // answer finally arrives.
    expect(telegramMsgId).toBe("4242");
    // `delivered` is a literal in the statement rather than a parameter, so the
    // assertion is on the text. It has to be false, or the queue reader skips
    // the row and the message stays lost — which is the whole point of the loop.
    expect(inserts[0]!.text).toContain("delivered)");
    expect(inserts[0]!.text).toContain(", false)");
  });

  test("the operator is told, with the project and how long it waited", async () => {
    const { db } = worldWith({ age_sec: 1265 });

    await checkUnansweredMessages(db.sql as never);

    const alert = http.last(SEND);
    const text = String((alert?.body as { text?: string })?.text ?? "");
    expect(text).toContain("helyx");
    expect(text).toContain("21m 5s");
    expect(text).toContain("почему упало?");
  });

  test("a long message is previewed, not pasted whole into the alert", async () => {
    const { db } = worldWith({ content: "x".repeat(400) });

    await checkUnansweredMessages(db.sql as never);

    const text = String((http.last(SEND)?.body as { text?: string })?.text ?? "");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(400);
  });

  test("the 🔥 reaction goes on the original message", async () => {
    const { db } = worldWith({});

    await checkUnansweredMessages(db.sql as never);

    const reaction = http.last(REACTION);
    expect(reaction).toBeDefined();
    const body = reaction!.body as { chat_id?: string; message_id?: number; reaction?: { emoji?: string }[] };
    expect(body.chat_id).toBe("-100123");
    expect(body.message_id).toBe(4242);
    expect(body.reaction?.[0]?.emoji).toBe("🔥");
  });

  test("no telegram message id means no reaction, and the re-queue still happens", async () => {
    // The reaction is a courtesy; putting the question back is the job.
    const { db } = worldWith({ telegram_msg_id: null });

    await checkUnansweredMessages(db.sql as never);

    expect(http.count(REACTION)).toBe(0);
    expect(db.count(INSERT_QUEUE)).toBe(1);
    expect(db.matching(INSERT_QUEUE)[0]!.values[4]).toBeNull();
  });
});

describe("a message that has already had its retry is left alone", () => {
  test("no second re-queue", async () => {
    const { db } = worldWith({
      content: markRequeued("почему упало?", "Re-injected — previous response was lost."),
    });

    await checkUnansweredMessages(db.sql as never);

    // Retrying it here would start a loop between this sweep and the channel's
    // response guard, each re-queueing what the other just re-queued.
    expect(db.count(INSERT_QUEUE)).toBe(0);
    expect(http.count(SEND)).toBe(0);
  });

  test("but the reaction is still set — the check comes after it", async () => {
    // Recorded as it is, not as it might ideally be: the 🔥 is set before the
    // already-re-queued test, so an unanswered retry is re-marked once per
    // dedup window. Harmless, and worth knowing before someone reorders these
    // two blocks and wonders why the reaction disappeared.
    const { db } = worldWith({
      content: markRequeued("почему упало?", "Re-injected — previous response was lost."),
    });

    await checkUnansweredMessages(db.sql as never);

    expect(http.count(REACTION)).toBe(1);
  });
});

describe("the dedup window", () => {
  test("a second sweep inside the window does nothing at all", async () => {
    const { db } = worldWith({});

    await checkUnansweredMessages(db.sql as never);
    expect(db.count(INSERT_QUEUE)).toBe(1);

    db.clear();
    http.requests.length = 0;
    await checkUnansweredMessages(db.sql as never);

    expect(db.count(INSERT_QUEUE)).toBe(0);
    expect(http.requests).toHaveLength(0);
  });

  test("a failed insert still consumes the window, so there is no retry until it expires", async () => {
    // Current behaviour, asserted rather than assumed. The dedup entry is
    // written before the insert is attempted, so a transient database error
    // costs the message its whole window. Whether that is right is a decision
    // for whoever changes it; what must not happen is changing it by accident.
    const { db } = worldWith({});
    db.program(INSERT_QUEUE, { error: new Error("deadlock detected") });

    await checkUnansweredMessages(db.sql as never);
    expect(db.count(INSERT_QUEUE)).toBe(1);
    // The alert is not sent: the loop moves on after a failed insert.
    expect(http.count(SEND)).toBe(0);

    db.clear();
    db.program(INSERT_QUEUE, { rows: [] });
    await checkUnansweredMessages(db.sql as never);

    expect(db.count(INSERT_QUEUE)).toBe(0);
  });
});

describe("nothing to do", () => {
  test("no qualifying messages means no requests and no rows", async () => {
    const db = new FakeSql();
    db.program(SELECT_UNANSWERED, { rows: [] });

    await checkUnansweredMessages(db.sql as never);

    expect(db.count(INSERT_QUEUE)).toBe(0);
    expect(http.requests).toHaveLength(0);
  });

  test("a failing query is survived without acting on it", async () => {
    // The SELECT ends in `.catch(() => [])`. That is deliberate — a supervisor
    // that dies on a database hiccup stops supervising — but it means an
    // unmatched fake looks exactly like a correct decision to do nothing, which
    // is why every other test here asserts a positive effect.
    const db = new FakeSql();
    db.program(SELECT_UNANSWERED, { error: new Error("connection reset") });

    await checkUnansweredMessages(db.sql as never);

    expect(db.count(INSERT_QUEUE)).toBe(0);
  });
});

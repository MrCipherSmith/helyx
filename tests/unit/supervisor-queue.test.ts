/**
 * Loop 2 — messages sitting in the queue that nobody has taken.
 *
 * The same shape as the hung-session loop and the same stakes: an alert with
 * buttons that do things. The one difference worth testing separately is the
 * force-deliver button, which is keyed by *session* while the restart button
 * beside it is keyed by *project* — the two ids are different numbers and the
 * comment in the source records what happened the last time they were mixed up.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { checkStuckQueue } from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { restartCallbackData, forceDeliverCallbackData } from "../../utils/supervisor-callbacks.ts";
import { uniqueName } from "../fixtures/unique.ts";

// Narrow on purpose. `forwardStuckMessages` runs at the end of this loop and
// selects from message_queue too, so a match on the table name alone hands it
// the same rows and it forwards them — which is how the first version of these
// tests ended up asserting against the wrong message entirely.
const SELECT_STUCK = "COUNT(*) AS stuck_count";
const SELECT_FORWARDABLE = "mq.forwarded_at IS NULL";
const INSERT_INCIDENT = "INSERT INTO supervisor_incidents";
const SEND = "sendMessage";

let http: FakeFetch;
let restore: () => void;

beforeEach(() => {
  ({ http, restore } = installFakeFetch());
  http.program("api.telegram.org", { json: { ok: true, result: { message_id: 900 } } });
});

afterEach(() => restore());

function stuckWorld(options: { oldestSec?: number; count?: number; content?: string } = {}) {
  const project = uniqueName("queue-proj");
  const db = new FakeSql();
  db.program(SELECT_FORWARDABLE, { rows: [] });
  db.program(SELECT_STUCK, {
    rows: [
      {
        session_id: 77,
        project_id: 9,
        project,
        project_path: "/srv/helyx",
        oldest_pending: new Date(Date.now() - (options.oldestSec ?? 700) * 1000),
        first_msg_content: options.content ?? "разверни прод",
        stuck_count: options.count ?? 3,
      },
    ],
  });
  return { db, project };
}

function alertText(): string {
  return String((http.last(SEND)?.body as { text?: string })?.text ?? "");
}

function alertButtons(): { text: string; callback_data: string }[] {
  const body = http.last(SEND)?.body as { reply_markup?: { inline_keyboard?: never[][] } };
  return ((body?.reply_markup?.inline_keyboard ?? []) as { text: string; callback_data: string }[][]).flat();
}

describe("a queue nobody is draining", () => {
  test("the alert says how many are waiting and for how long", async () => {
    const { db, project } = stuckWorld({ oldestSec: 725, count: 4 });

    await checkStuckQueue(db.sql as never);

    const text = alertText();
    expect(text).toContain(project);
    expect(text).toContain("4");
    expect(text).toContain("12m 5s");
    expect(text).toContain("разверни прод");
  });

  test("force-deliver is keyed by session and restart by project", async () => {
    // Two ids, two meanings, side by side on one keyboard. Sending a session id
    // where a project id belongs made every restart button here answer "project
    // not found" — the source still carries the comment.
    const { db } = stuckWorld();

    await checkStuckQueue(db.sql as never);

    const payloads = alertButtons().map((b) => b.callback_data);
    expect(payloads).toContain(forceDeliverCallbackData(77));
    expect(payloads).toContain(restartCallbackData(9));
  });

  test("an incident is recorded against the session", async () => {
    const { db, project } = stuckWorld();

    await checkStuckQueue(db.sql as never);

    const incidents = db.matching(INSERT_INCIDENT);
    expect(incidents).toHaveLength(1);
    const [type, loggedProject, sessionId] = incidents[0]!.values;
    expect(type).toBe("stuck_queue");
    expect(loggedProject).toBe(project);
    expect(sessionId).toBe(77);
  });

  test("a long first message is previewed", async () => {
    const { db } = stuckWorld({ content: "y".repeat(500) });

    await checkStuckQueue(db.sql as never);

    expect(alertText()).toContain("…");
    expect(alertText().length).toBeLessThan(500);
  });

  test("the pane reaches the message when a shell is available", async () => {
    // It did not, until it did: the pane was captured and then dropped on the
    // floor here while the hung-session alert included it, so the operator lost
    // the one piece of context saying what the session was actually doing.
    const { db } = stuckWorld();
    const runShell = async () => ({ ok: true, output: "waiting on lock\nstill waiting" });

    await checkStuckQueue(db.sql as never, runShell);

    expect(alertText()).toContain("still waiting");
  });

  test("a spinner turns the restart button into a warning", async () => {
    const { db } = stuckWorld();
    const runShell = async () => ({ ok: true, output: "✻ Compacting conversation…" });

    await checkStuckQueue(db.sql as never, runShell);

    expect(alertText()).toContain("ждёт завершения задачи");
    const restart = alertButtons().find((b) => b.callback_data.includes("restart"));
    expect(restart?.text).toContain("Claude работает");
  });
});

describe("nothing stuck", () => {
  test("a healthy queue produces no alert and no incident", async () => {
    const db = new FakeSql();
    db.program(SELECT_FORWARDABLE, { rows: [] });
    db.program(SELECT_STUCK, { rows: [] });

    await checkStuckQueue(db.sql as never);

    expect(http.count(SEND)).toBe(0);
    expect(db.count(INSERT_INCIDENT)).toBe(0);
  });
});

describe("forwarding what nobody took", () => {
  // Every other test here programs the forwarding query empty, which means
  // deleting the `forwardStuckMessages(sql)` call at the end of the loop would
  // leave them all green. This is the case that notices.
  function forwardableWorld() {
    const project = uniqueName("fwd-proj");
    const db = new FakeSql();
    db.program(SELECT_STUCK, { rows: [] });
    db.program(SELECT_FORWARDABLE, {
      rows: [
        {
          id: 991,
          session_id: 77,
          chat_id: "-100123",
          from_user: "altsay",
          content: "почему <div> не рендерится?",
          project,
          age_seconds: 900,
        },
      ],
    });
    return { db, project };
  }

  test("a message past the threshold is forwarded to the fallback channel", async () => {
    const { db, project } = forwardableWorld();

    await checkStuckQueue(db.sql as never);

    const forward = http.last(SEND);
    const body = forward!.body as { text?: string; message_thread_id?: number };
    expect(body.text).toContain(project);
    expect(body.text).toContain("15m ago");
    expect(body.message_thread_id).toBe(7);
  });

  test("and marked forwarded, so it is not sent again", async () => {
    const { db } = forwardableWorld();

    await checkStuckQueue(db.sql as never);

    const marks = db.matching("SET forwarded_at = NOW()");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.values[0]).toBe(991);
  });

  test("the message is escaped — an angle bracket must not lose the forward", async () => {
    // parse_mode is HTML and this is the operator's own text, pasted whole.
    // Unescaped, Telegram rejects the send and tgPost swallows the failure: the
    // last-resort delivery for a message nothing else could deliver, lost to a
    // "<".
    const { db } = forwardableWorld();

    await checkStuckQueue(db.sql as never);

    const text = String((http.last(SEND)?.body as { text?: string })?.text ?? "");
    expect(text).toContain("&lt;div&gt;");
    expect(text).not.toContain("<div>");
  });
});

describe("the stuck-queue alert escapes what the operator wrote", () => {
  test("an angle bracket in the first message does not break the send", async () => {
    const { db } = stuckWorld({ content: "почему <b>это</b> сломалось?" });

    await checkStuckQueue(db.sql as never);

    const text = alertText();
    expect(text).toContain("&lt;b&gt;");
    // The tags the supervisor itself writes are still real markup.
    expect(text).toContain("<code>");
  });
});

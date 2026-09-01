/**
 * Loop 1 — the session that stopped answering.
 *
 * What this loop produces is a message with buttons, and the buttons are the
 * part that matters: an operator presses "restart" and something is restarted.
 * A callback payload carrying the wrong id has happened here before — the
 * stuck-queue alert once sent a session id where a project id was expected, so
 * every restart button answered "project not found" — which is why these tests
 * assert the payloads against the builders rather than against a literal.
 *
 * The dedup key is module state, so each test uses its own project name.
 * Where a test is about the dedup itself, it reuses one deliberately.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { checkHungSessions } from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { restartCallbackData, paneCallbackData, ackCallbackData } from "../../utils/supervisor-callbacks.ts";
import { uniqueName } from "../fixtures/unique.ts";

const SELECT_HUNG = "FROM active_status_messages";
const INSERT_INCIDENT = "INSERT INTO supervisor_incidents";
const SEND = "sendMessage";
const EDIT = "editMessageText";

let http: FakeFetch;
let restore: () => void;
let nextMessageId = 500;

beforeEach(() => {
  ({ http, restore } = installFakeFetch());
  nextMessageId = 500;
  http.program("api.telegram.org", () => ({ json: { ok: true, result: { message_id: nextMessageId++ } } }));
});

afterEach(() => restore());

function freshProject(): string {
  // Unique across the whole process, not just this file: the supervisor's dedup
  // maps are module state and outlive a re-run of these tests.
  return uniqueName("hung-proj");
}

function hungWorld(options: { project?: string; staleSec?: number; projectId?: number } = {}) {
  const project = options.project ?? freshProject();
  const staleSec = options.staleSec ?? 305;
  const db = new FakeSql();
  db.program(SELECT_HUNG, {
    rows: [
      {
        session_id: 11,
        project,
        project_path: "/home/altsay/bots/helyx",
        project_id: options.projectId ?? 3,
        key: `asm:${project}`,
        started_at: new Date(Date.now() - staleSec * 1000),
        updated_at: new Date(Date.now() - staleSec * 1000),
      },
    ],
  });
  return { db, project };
}

function lastAlertText(): string {
  return String((http.last(SEND)?.body as { text?: string })?.text ?? "");
}

function lastAlertButtons(): { text: string; callback_data: string }[][] {
  const body = http.last(SEND)?.body as { reply_markup?: { inline_keyboard?: never[][] } };
  return (body?.reply_markup?.inline_keyboard ?? []) as { text: string; callback_data: string }[][];
}

describe("a stale session raises an alert", () => {
  test("the alert names the project, its path and how long it has been silent", async () => {
    const { db, project } = hungWorld({ staleSec: 425 });

    await checkHungSessions(db.sql as never);

    const text = lastAlertText();
    expect(text).toContain(project);
    expect(text).toContain("/home/altsay/bots/helyx");
    expect(text).toContain("7m 5s");
  });

  test("the buttons carry the payloads their handlers expect", async () => {
    const { db, project } = hungWorld({ projectId: 42 });

    await checkHungSessions(db.sql as never);

    const buttons = lastAlertButtons().flat();
    const payloads = buttons.map((b) => b.callback_data);
    // Built from the shared builders, not spelled out: a literal here would
    // still match after someone changed the format on both sides but forgot
    // this loop.
    expect(payloads).toContain(restartCallbackData(42));
    expect(payloads).toContain(paneCallbackData(42));
    expect(payloads).toContain(ackCallbackData(project, 42));
  });

  test("an incident is recorded", async () => {
    const { db, project } = hungWorld();

    await checkHungSessions(db.sql as never);

    const incidents = db.matching(INSERT_INCIDENT);
    expect(incidents).toHaveLength(1);
    const [type, loggedProject, sessionId, action, result] = incidents[0]!.values;
    expect(type).toBe("hung_session");
    expect(loggedProject).toBe(project);
    expect(sessionId).toBe(11);
    expect(action).toBe("alerted_user");
    expect(result).toBe("pending");
  });

  test("a healthy fleet produces nothing", async () => {
    const db = new FakeSql();
    db.program(SELECT_HUNG, { rows: [] });

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(0);
    expect(db.count(INSERT_INCIDENT)).toBe(0);
  });
});

describe("what the pane adds", () => {
  test("a working spinner is reported, and the restart button says so", async () => {
    const { db } = hungWorld();
    const runShell = async () => ({ ok: true, output: "✻ Thinking… (12s · 400 tokens)" });

    await checkHungSessions(db.sql as never, runShell);

    const text = lastAlertText();
    expect(text).toContain("Claude сейчас работает");
    // The operator is about to press restart on a session that is mid-task —
    // the warning belongs on the button, where the finger is.
    const restart = lastAlertButtons().flat().find((b) => b.callback_data.includes("restart"));
    expect(restart?.text).toContain("Claude работает");
  });

  test("the last pane lines reach the message", async () => {
    const { db } = hungWorld();
    const runShell = async () => ({ ok: true, output: "line one\nline two\nline three" });

    await checkHungSessions(db.sql as never, runShell);

    expect(lastAlertText()).toContain("line three");
  });

  test("with no shell the session is still alerted, just without context", async () => {
    // The pane is context, not a precondition. Skipping the session when no
    // shell is available would mean the supervisor goes quiet exactly where it
    // cannot see.
    const { db, project } = hungWorld();

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(1);
    expect(lastAlertText()).toContain(project);
    expect(lastAlertText()).not.toContain("Пане");
  });
});

describe("when another loop has already alerted", () => {
  test("the existing message is edited instead of a second one being sent", async () => {
    // Never exercised before. Two loops watch the same session from different
    // angles, and both firing means two alerts about one problem.
    const project = freshProject();
    const first = hungWorld({ project, staleSec: 305 });

    await checkHungSessions(first.db.sql as never);
    expect(http.count(SEND)).toBe(1);

    const second = hungWorld({ project, staleSec: 610 });
    await checkHungSessions(second.db.sql as never);

    expect(http.count(SEND)).toBe(1);
    const edit = http.last(EDIT);
    expect(edit).toBeDefined();
    const body = edit!.body as { message_id?: number; text?: string };
    expect(body.message_id).toBe(500);
    // The edit appends rather than replacing: the original alert's buttons and
    // text are what the operator is looking at.
    expect(body.text).toContain(project);
    expect(body.text).toContain("Также");
    expect(body.text).toContain("10m 10s");
  });

  test("no second incident is logged for the same problem", async () => {
    const project = freshProject();
    await checkHungSessions(hungWorld({ project }).db.sql as never);

    const second = hungWorld({ project });
    await checkHungSessions(second.db.sql as never);

    expect(second.db.count(INSERT_INCIDENT)).toBe(0);
  });
});

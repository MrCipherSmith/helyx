/**
 * Loop 12 — the channel that stopped renewing its lease.
 *
 * The gap this loop closes: a channel.ts killed outright (the 2026-09-29 OOM
 * incident) leaves `claude` running with no MCP bridge. `checkHungSessions`
 * cannot see it — no status message, no pane spinner, nothing to go stale —
 * because no turn ever started. This loop's only signal is
 * `sessions.lease_expires_at`, which stops advancing the moment the channel's
 * heartbeat stops.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { checkChannelHeartbeat } from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { restartCallbackData, paneCallbackData, ackCallbackData } from "../../utils/supervisor-callbacks.ts";
import { uniqueName } from "../fixtures/unique.ts";

const SELECT_STALE_LEASE = "lease_expires_at < NOW";
const INSERT_INCIDENT = "INSERT INTO supervisor_incidents";
const SEND = "sendMessage";
const EDIT = "editMessageText";

let http: FakeFetch;
let restore: () => void;
let nextMessageId = 700;

beforeEach(() => {
  ({ http, restore } = installFakeFetch());
  nextMessageId = 700;
  http.program("api.telegram.org", () => ({ json: { ok: true, result: { message_id: nextMessageId++ } } }));
});

afterEach(() => restore());

function freshProject(): string {
  return uniqueName("channel-proj");
}

function staleChannelWorld(options: { project?: string; staleSec?: number; projectId?: number } = {}) {
  const project = options.project ?? freshProject();
  const staleSec = options.staleSec ?? 305;
  const db = new FakeSql();
  db.program(SELECT_STALE_LEASE, {
    rows: [
      {
        session_id: 21,
        project,
        project_path: "/home/altsay/keryx",
        project_id: options.projectId ?? 7,
        lease_expires_at: new Date(Date.now() - staleSec * 1000),
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

describe("a dead channel raises an alert", () => {
  test("the alert names the project, its path and how long the lease has been stale", async () => {
    const { db, project } = staleChannelWorld({ staleSec: 425 });

    await checkChannelHeartbeat(db.sql as never);

    const text = lastAlertText();
    expect(text).toContain(project);
    expect(text).toContain("/home/altsay/keryx");
    expect(text).toContain("7m 5s");
  });

  test("the buttons carry the payloads their handlers expect", async () => {
    const { db, project } = staleChannelWorld({ projectId: 99 });

    await checkChannelHeartbeat(db.sql as never);

    const buttons = lastAlertButtons().flat();
    const payloads = buttons.map((b) => b.callback_data);
    expect(payloads).toContain(restartCallbackData(99));
    expect(payloads).toContain(paneCallbackData(99));
    expect(payloads).toContain(ackCallbackData(project, 99));
  });

  test("an incident is recorded with type channel_dead", async () => {
    const { db, project } = staleChannelWorld();

    await checkChannelHeartbeat(db.sql as never);

    const incidents = db.matching(INSERT_INCIDENT);
    expect(incidents).toHaveLength(1);
    const [type, loggedProject, sessionId, action, result] = incidents[0]!.values;
    expect(type).toBe("channel_dead");
    expect(loggedProject).toBe(project);
    expect(sessionId).toBe(21);
    expect(action).toBe("alerted_user");
    expect(result).toBe("pending");
  });

  test("no auto-restart happens — only the alert is sent", async () => {
    // The Restart Control Reform removed auto-restarts from this codebase.
    // This loop follows the same convention as every other one: alert with a
    // button, and the operator decides.
    const { db } = staleChannelWorld();

    await checkChannelHeartbeat(db.sql as never);

    expect(db.count("UPDATE sessions")).toBe(0);
    expect(db.count("INSERT INTO admin_commands")).toBe(0);
  });

  test("a fleet with fresh leases produces nothing", async () => {
    const db = new FakeSql();
    db.program(SELECT_STALE_LEASE, { rows: [] });

    await checkChannelHeartbeat(db.sql as never);

    expect(http.count(SEND)).toBe(0);
    expect(db.count(INSERT_INCIDENT)).toBe(0);
  });
});

describe("what the pane adds", () => {
  test("the last pane lines reach the message", async () => {
    const { db } = staleChannelWorld();
    const runShell = async () => ({ ok: true, output: "line one\nline two\nline three" });

    await checkChannelHeartbeat(db.sql as never, runShell);

    expect(lastAlertText()).toContain("line three");
  });

  test("with no shell the session is still alerted, just without context", async () => {
    const { db, project } = staleChannelWorld();

    await checkChannelHeartbeat(db.sql as never);

    expect(http.count(SEND)).toBe(1);
    expect(lastAlertText()).toContain(project);
    expect(lastAlertText()).not.toContain("Пане");
  });
});

describe("when another loop has already alerted", () => {
  test("the existing message is edited instead of a second one being sent", async () => {
    const project = freshProject();
    const first = staleChannelWorld({ project, staleSec: 305 });

    await checkChannelHeartbeat(first.db.sql as never);
    expect(http.count(SEND)).toBe(1);

    const second = staleChannelWorld({ project, staleSec: 610 });
    await checkChannelHeartbeat(second.db.sql as never);

    expect(http.count(SEND)).toBe(1);
    const edit = http.last(EDIT);
    expect(edit).toBeDefined();
    const body = edit!.body as { message_id?: number; text?: string };
    expect(body.message_id).toBe(700);
    expect(body.text).toContain(project);
    expect(body.text).toContain("Также");
  });

  test("no second incident is logged for the same problem", async () => {
    const project = freshProject();
    await checkChannelHeartbeat(staleChannelWorld({ project }).db.sql as never);

    const second = staleChannelWorld({ project });
    await checkChannelHeartbeat(second.db.sql as never);

    expect(second.db.count(INSERT_INCIDENT)).toBe(0);
  });
});

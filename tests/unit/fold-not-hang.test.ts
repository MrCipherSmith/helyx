/**
 * Two minutes of compaction is not a dead session.
 *
 * `durationMs` was 119544 and 149137 on the two folds observed in this project's
 * own transcript on 2026-08-08 — over two minutes each, during which the session
 * answers nothing, its status message stops changing and its transcript gains no
 * lines. Both watchdogs read that as silence and both fire at five minutes, so a
 * fold that starts partway through a quiet stretch lands inside the alarm rather
 * than beside it: the operator is told the session has died by the one thing that
 * knew it had not.
 *
 * Four places have to agree, and they are in three processes. The hook tells the
 * bot the fold is starting; the marker crosses `sessions.metadata`; the
 * supervisor in the container and the guard on the host both ask before they
 * alarm; and the status message says what the silence is.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import { renderStatus } from "../../utils/status-render.ts";
import { checkHungSessions } from "../../scripts/supervisor.ts";
import { handleMcpRequest, setMcpDeps, type McpDeps } from "../../mcp/server.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { uniqueName } from "../fixtures/unique.ts";
import type { StatusContext } from "../../channel/status.ts";

const CHAT = "-1005550003";
const SELECT_METADATA = "SELECT metadata FROM sessions";
const SELECT_SESSION_ROW = "SELECT pane_snapshot, pane_snapshot_at, metadata FROM sessions";
const UPDATE_METADATA = "UPDATE sessions SET metadata";

/** Both alarms, for the reason `guard-open-question.test.ts` watches both. */
const ALARMS = ["думает уже 5+ мин", "не отвечает"];

/** A fold that started thirty seconds ago — well inside every window. */
const folding = () => ({ fold: { startedAt: Date.now() - 30_000, trigger: "auto" } });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("the status message says what the silence is", () => {
  test("the fold is named, above the work block", () => {
    const text = renderStatus({ stage: "⏳ Thinking", elapsed: "3m 20s", foldingMs: 65_000 });
    expect(text).toContain("сворачивает контекст");
    // Above the quote, not inside it: `tailWithinBudget` trims the quote from the
    // front, so a line written into it is the first thing dropped.
    expect(text.indexOf("сворачивает контекст")).toBeLessThan(text.indexOf("Thinking"));
  });

  test("the duration is rounded, so the dedup hash still works", () => {
    // The message text is hashed to suppress redundant edits. A field that
    // changed every millisecond would make every tick a Telegram request.
    const a = renderStatus({ stage: "⏳ Thinking", elapsed: "1m", foldingMs: 65_000 });
    const b = renderStatus({ stage: "⏳ Thinking", elapsed: "1m", foldingMs: 65_400 });
    expect(a).toBe(b);
  });

  test("an ordinary turn says nothing about folding", () => {
    for (const foldingMs of [null, undefined]) {
      expect(renderStatus({ stage: "⏳ Thinking", elapsed: "3s", foldingMs })).not.toContain("контекст");
    }
  });

  test("the status a folding session is showing carries the line", async () => {
    // The whole chain: the marker in the row, read on the tick, into the text
    // Telegram is asked to show.
    const { telegram, restore } = await installFakeTelegram();
    cleanups.push(restore);
    const db = new FakeSql();
    db.program("FROM chat_sessions", { rows: [] });
    db.program(SELECT_SESSION_ROW, {
      rows: [{ pane_snapshot: null, pane_snapshot_at: null, metadata: folding() }],
    });

    const { StatusManager } = await import("../../channel/status.ts");
    const status = new StatusManager(
      {
        sql: db.sql as unknown as StatusContext["sql"],
        sessionId: () => 7,
        sessionName: () => "helyx",
        projectName: "helyx",
        token: () => "fake-token",
      },
      // The floor between edits is measured in seconds and this test is not
      // going to wait one out; what it is about is the text of the edit.
      { minEditIntervalMs: 0 },
    );
    cleanups.push(() => void status.deleteStatusMessage(CHAT));

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.refreshStatusFromSession(CHAT);
    await status.updateStatus(CHAT, "⏳ Thinking");

    expect(telegram.edits.map((e) => e.text).join("\n")).toContain("сворачивает контекст");
  });
});

describe("the response guard and a fold", () => {
  /**
   * When the guard is taken to have fired.
   *
   * `runResponseGuard` takes its `now` for the reason the spinner does — five
   * minutes of waiting is not a test — and the marker is compared against that
   * same clock. So a fold in these tests starts relative to `FIRED_AT`, not to
   * the wall clock: a marker written "now" and read from ten minutes in the
   * future is a stale marker, which is a different test.
   */
  const FIRED_AT = Date.now() + 10 * 60_000;
  /** A fold that started thirty seconds before the guard fired. */
  const foldingWhenFired = () => ({ fold: { startedAt: FIRED_AT - 30_000, trigger: "auto" } });

  /** A manager whose guard is about to be fired by hand. */
  async function firedGuard(metadata: unknown) {
    const { telegram, restore } = await installFakeTelegram();
    cleanups.push(restore);

    const db = new FakeSql();
    db.program("FROM chat_sessions", { rows: [] });
    db.program("FROM question_requests", { rows: [] });
    db.program("FROM message_queue", { rows: [] });
    db.program(SELECT_METADATA, { rows: [{ metadata }] });

    const { StatusManager } = await import("../../channel/status.ts");
    const status = new StatusManager({
      sql: db.sql as unknown as StatusContext["sql"],
      sessionId: () => 7,
      sessionName: () => "helyx",
      projectName: "helyx",
      token: () => "fake-token",
    });
    cleanups.push(() => void status.deleteStatusMessage(CHAT));

    return { status, telegram, db };
  }

  const everything = (t: { texts: () => string[]; edits: { text: string }[] }) =>
    [...t.texts(), ...t.edits.map((e) => e.text)].join("\n");

  test("the marker is consulted at all", async () => {
    const { status, db } = await firedGuard(foldingWhenFired());

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, FIRED_AT);

    expect(db.count(SELECT_METADATA)).toBeGreaterThan(0);
  });

  test("no alarm while the session is folding", async () => {
    const { status, telegram } = await firedGuard(foldingWhenFired());

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, FIRED_AT);

    const sent = everything(telegram);
    for (const alarm of ALARMS) expect([alarm, sent.includes(alarm)]).toEqual([alarm, false]);
  });

  test("the status is left open — the turn has not ended", async () => {
    // The alarm's other half is `deleteStatusMessage`, which unblocks the chat
    // and lets the next message be delivered into a session mid-fold.
    const { status, telegram } = await firedGuard(foldingWhenFired());

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, FIRED_AT);

    expect(telegram.deletes).toHaveLength(0);
    expect(status.getBusyChats().has(CHAT)).toBe(true);
  });

  test("but a session that is not folding is still alarmed about", async () => {
    // The exemption narrows the alarm; it does not switch it off.
    const { status, telegram } = await firedGuard({});

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, FIRED_AT);

    expect(ALARMS.some((a) => everything(telegram).includes(a))).toBe(true);
  });

  test("and neither does a marker left behind by a fold that never finished", async () => {
    // A CLI that died mid-compaction leaves the marker set. Believing it for
    // ever would mute the alarm for that session permanently.
    const { status, telegram } = await firedGuard({ fold: { startedAt: FIRED_AT - 60 * 60_000, trigger: "auto" } });

    await status.sendStatusMessage(CHAT, "⏳ Thinking");
    await status.runResponseGuard(CHAT, FIRED_AT);

    expect(ALARMS.some((a) => everything(telegram).includes(a))).toBe(true);
  });
});

describe("the supervisor's hung-session loop and a fold", () => {
  let http: FakeFetch;
  let restoreFetch: () => void;

  beforeEach(() => {
    ({ http, restore: restoreFetch } = installFakeFetch());
    http.program("api.telegram.org", () => ({ json: { ok: true, result: { message_id: 700 } } }));
  });

  afterEach(() => restoreFetch());

  /** A stale session, as Loop 1's query returns one. */
  function staleSession(metadata: unknown) {
    // The loop's dedup map is module state and outlives a re-run of this file.
    const project = uniqueName("fold-proj");
    const db = new FakeSql();
    db.program("JOIN active_status_messages asm", {
      rows: [{
        session_id: 11,
        project,
        project_path: "/home/altsay/bots/helyx",
        project_id: 3,
        key: `asm:${project}`,
        started_at: new Date(Date.now() - 400_000),
        updated_at: new Date(Date.now() - 400_000),
      }],
    });
    db.program(SELECT_METADATA, { rows: [{ metadata }] });
    return { db, project };
  }

  test("a folding session raises no alert and logs no incident", async () => {
    const { db } = staleSession(folding());

    await checkHungSessions(db.sql as never);

    expect(http.count("sendMessage")).toBe(0);
    expect(db.count("INSERT INTO supervisor_incidents")).toBe(0);
  });

  test("a session silent for any other reason is still alerted on", async () => {
    const { db, project } = staleSession({});

    await checkHungSessions(db.sql as never);

    expect(http.count("sendMessage")).toBe(1);
    expect(String((http.last("sendMessage")?.body as { text?: string })?.text ?? "")).toContain(project);
  });
});

describe("the PreCompact hook is what starts the marker", () => {
  const HOOK_PATH = "/api/hooks/pre-compact";
  let db: FakeSql;
  let restoreDeps: (() => void) | undefined;
  let summarized: string[];

  function recorder(): { res: ServerResponse; answer: { status: number; body: string } } {
    const answer = { status: 0, body: "" };
    const res = {
      writeHead(status: number) { answer.status = status; return res; },
      setHeader() {},
      write(chunk: string) { answer.body += chunk; return true; },
      end(chunk?: string) { if (chunk) answer.body += chunk; },
      get headersSent() { return answer.status !== 0; },
      on() { return res; },
      off() { return res; },
    } as unknown as ServerResponse;
    return { res, answer };
  }

  function request(body: unknown): IncomingMessage {
    const raw = JSON.stringify(body);
    const req = {
      method: "POST",
      url: HOOK_PATH,
      headers: { host: "localhost:3847" },
      socket: { remoteAddress: "127.0.0.1" },
      on(event: string, cb: (chunk?: string) => void) {
        if (event === "data") cb(raw);
        if (event === "end") cb();
        return req;
      },
      off() { return req; },
    } as unknown as IncomingMessage;
    return req;
  }

  /** The marker write is fire-and-forget; let its microtasks run. */
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  beforeEach(() => {
    db = new FakeSql();
    summarized = [];
    restoreDeps = setMcpDeps({
      sql: db.sql as unknown as McpDeps["sql"],
      summarizeBeforeCompact: (async (projectPath: string) => { summarized.push(projectPath); }) as McpDeps["summarizeBeforeCompact"],
    });
  });

  afterEach(() => { restoreDeps?.(); restoreDeps = undefined; });

  test("the fold is marked for the session running in that directory", async () => {
    db.program("SELECT id FROM sessions", { rows: [{ id: 11 }] });
    const { res, answer } = recorder();

    await handleMcpRequest(request({
      transcript_path: "/home/someone/.claude/projects/slug/session.jsonl",
      project_path: "/home/altsay/bots/helyx",
      trigger: "auto",
    }), res, null);
    await settle();

    expect(answer.status).toBe(200);
    const [update] = db.matching(UPDATE_METADATA);
    expect(update).toBeDefined();
    // The trigger travels with it: "auto" is the window filling up, "manual" is
    // something having typed `/compact`.
    expect(update!.values[1]).toBe("auto");
    expect(update!.values[2]).toBe(11);
  });

  test("the summariser still runs, and still runs first", async () => {
    // AC7: this flow adds a marker to the hook and changes nothing about what
    // the Telegram summariser reads or when. The hook still holds compaction
    // open on the summary.
    db.program("SELECT id FROM sessions", { rows: [{ id: 11 }] });
    const { res } = recorder();

    await handleMcpRequest(request({
      transcript_path: "/home/someone/.claude/projects/slug/session.jsonl",
      project_path: "/home/altsay/bots/helyx",
      trigger: "auto",
    }), res, null);

    expect(summarized).toEqual(["/home/altsay/bots/helyx"]);
  });

  test("a refused request marks nothing", async () => {
    // The path validation predates this and still comes first: a marker written
    // before the refusal would suppress a hung-session alarm on the strength of
    // a request the door said no to.
    const { res, answer } = recorder();

    await handleMcpRequest(request({
      transcript_path: "/etc/passwd",
      project_path: "/home/altsay/bots/helyx",
      trigger: "auto",
    }), res, null);
    await settle();

    expect(answer.status).toBe(400);
    expect(db.count(UPDATE_METADATA)).toBe(0);
  });
});

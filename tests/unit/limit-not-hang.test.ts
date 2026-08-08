/**
 * A session that hit its limit is not a session that hung.
 *
 * From outside they are the same silence. Twelve times between 2026-07-07 and
 * 2026-08-08 a session in this project stopped answering because the account was
 * out of allowance; five minutes later the hung-session loop found it stale and
 * offered the operator a restart button, which restarts a process that was never
 * the problem — the limit is on the account. The session comes back and stops
 * again, and the operator has been told "not responding" about something that is
 * merely "not allowed to respond until 5:30pm".
 *
 * Three processes have to agree, as with the fold: the channel reads the error
 * off the transcript on the host, the marker crosses `sessions.metadata`, and
 * the supervisor in the container decides both what to say and what not to.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkHungSessions,
  checkLimitedSessions,
  checkStuckQueue,
  forwardStuckMessages,
  resetLimitAlerts,
} from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { uniqueName } from "../fixtures/unique.ts";
import { restartCallbackData } from "../../utils/supervisor-callbacks.ts";
import type { StatusContext } from "../../channel/status.ts";

const SELECT_METADATA = "SELECT metadata FROM sessions";
const LIMIT_SCAN = "s.metadata ? 'limit'";
const SEND = "sendMessage";
const INSERT_INCIDENT = "INSERT INTO supervisor_incidents";

const HOUR = 60 * 60_000;

/** A session limit that started a minute ago and lifts in an hour. */
function liveLimit(overrides: Record<string, unknown> = {}) {
  return {
    kind: "session-limit",
    text: "You've hit your session limit · resets 5:30pm (UTC)",
    startedAt: Date.now() - 60_000,
    resetsAt: Date.now() + HOUR,
    uuid: "err-1",
    ...overrides,
  };
}

let http: FakeFetch;
let restoreFetch: () => void;

beforeEach(() => {
  resetLimitAlerts();
  ({ http, restore: restoreFetch } = installFakeFetch());
  http.program("api.telegram.org", () => ({ json: { ok: true, result: { message_id: 900 } } }));
});

afterEach(() => restoreFetch());

const sentTexts = () => http.matching(SEND).map((c) => String((c.body as { text?: string })?.text ?? ""));
const sentButtons = () =>
  http
    .matching(SEND)
    .flatMap((c) => ((c.body as { reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } })
      ?.reply_markup?.inline_keyboard ?? []).flat());

/** One active session under a live limit, as the scan returns it. */
function limitedWorld(limit: Record<string, unknown> = liveLimit()) {
  const project = uniqueName("limited-proj");
  const db = new FakeSql();
  db.program(LIMIT_SCAN, { rows: [{ session_id: 11, project, metadata: { limit } }] });
  return { db, project };
}

describe("the supervisor says which limit, and when it lifts", () => {
  test("the alert names the limit and its reset time", async () => {
    const { db, project } = limitedWorld();

    await checkLimitedSessions(db.sql as never);

    const text = sentTexts().join("\n");
    expect(text).toContain(project);
    expect(text).toContain("лимит сессии");
    // Resolved to an instant by the channel and rendered as a wall clock: the
    // operator is waiting for a time of day, not for a duration.
    expect(text).toMatch(/до \d{2}:\d{2} UTC/);
  });

  test("exactly one alert, however many times the marker is read", async () => {
    // The loop runs every sixty seconds and a session limit lasts hours: three
    // hundred passes over one event. The transcript entry's uuid is what makes
    // them one event — the same job `tailUuid` does for a fold.
    const { db } = limitedWorld();

    for (let i = 0; i < 5; i++) await checkLimitedSessions(db.sql as never);

    expect(http.count(SEND)).toBe(1);
  });

  test("a second limit in the same session is a second event", async () => {
    const first = limitedWorld();
    await checkLimitedSessions(first.db.sql as never);

    const db = new FakeSql();
    db.program(LIMIT_SCAN, {
      rows: [{ session_id: 11, project: first.project, metadata: { limit: liveLimit({ uuid: "err-2" }) } }],
    });
    await checkLimitedSessions(db.sql as never);

    expect(http.count(SEND)).toBe(2);
  });

  test("nothing to press: a restart cannot lift a limit", async () => {
    const { db } = limitedWorld();

    await checkLimitedSessions(db.sql as never);

    expect(sentButtons()).toEqual([]);
    expect(sentTexts().join("\n")).toContain("Перезапуск не поможет");
  });

  test("the weekly limit is named as itself", async () => {
    const { db } = limitedWorld(liveLimit({ kind: "weekly-limit", uuid: "wk-1" }));

    await checkLimitedSessions(db.sql as never);

    expect(sentTexts().join("\n")).toContain("недельный лимит");
  });

  test("an expired marker is not an event", async () => {
    const { db } = limitedWorld(liveLimit({ startedAt: Date.now() - 3 * HOUR, resetsAt: Date.now() - 2 * HOUR }));

    await checkLimitedSessions(db.sql as never);

    expect(http.count(SEND)).toBe(0);
  });
});

describe("the hung-session loop and a limit", () => {
  /** A stale session, as Loop 1's query returns one, carrying `metadata`. */
  function staleSession(metadata: unknown) {
    const project = uniqueName("limit-hung");
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

  test("a limited session raises no hang alert and logs no incident", async () => {
    const { db } = staleSession({ limit: liveLimit() });

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(0);
    expect(db.count(INSERT_INCIDENT)).toBe(0);
  });

  test("the operator gets one message about it, and it is the limit one", async () => {
    // Both checks run on the same timer, in this order. The limit scan speaks;
    // the hung loop holds its alarm. One event, one message, and the message
    // says the thing that is true.
    const limit = liveLimit();
    const { db, project } = staleSession({ limit });
    db.program(LIMIT_SCAN, { rows: [{ session_id: 11, project, metadata: { limit } }] });

    await checkLimitedSessions(db.sql as never);
    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(1);
    expect(sentTexts()[0]).toContain("под лимитом");
    expect(sentButtons().map((b) => b.callback_data)).not.toContain(restartCallbackData(3));
  });

  test("once the reset time has passed the alarm comes back", async () => {
    // A marker that outlived its limit would mute hung-session detection
    // exactly when the session is genuinely stuck — the failure this whole
    // expiry story exists to prevent.
    const { db, project } = staleSession({
      limit: liveLimit({ startedAt: Date.now() - 3 * HOUR, resetsAt: Date.now() - 60_000 }),
    });

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(1);
    expect(sentTexts()[0]).toContain(project);
  });

  test("and a marker with no reset time is not believed for ever either", async () => {
    const { db } = staleSession({
      limit: liveLimit({ startedAt: Date.now() - 2 * HOUR, resetsAt: null }),
    });

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(1);
  });

  test("a folding session is still exempt, beside a limit that has lifted", async () => {
    // AC8: flow 059's marker keeps working alongside the new one. Both live in
    // `sessions.metadata`, and the reader for each must ignore the other's key.
    const { db } = staleSession({
      fold: { startedAt: Date.now() - 30_000, trigger: "auto" },
      limit: liveLimit({ startedAt: Date.now() - 3 * HOUR, resetsAt: Date.now() - 2 * HOUR }),
    });

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(0);
  });
});

describe("held is not stuck", () => {
  /** A session with messages waiting and, optionally, a limit to wait for. */
  function queueWorld(metadata: unknown) {
    const project = uniqueName("held-proj");
    const db = new FakeSql();
    db.program("FROM message_queue mq", {
      rows: [{
        session_id: 11,
        project_id: 3,
        project,
        project_path: "/home/altsay/bots/helyx",
        oldest_pending: new Date(Date.now() - 600_000),
        first_msg_content: "посмотри, пожалуйста, на 061",
        stuck_count: 2,
      }],
    });
    db.program(SELECT_METADATA, { rows: [{ metadata }] });
    return { db, project };
  }

  test("a queue waiting on a limit raises no stuck-queue alert", async () => {
    // Two stories about one situation, and the wrong one would be the one with
    // a restart button on it.
    const { db } = queueWorld({ limit: liveLimit() });

    await checkStuckQueue(db.sql as never);

    expect(http.count(SEND)).toBe(0);
    expect(db.count(INSERT_INCIDENT)).toBe(0);
  });

  test("a queue stuck for any other reason is still alerted on", async () => {
    // The exemption narrows the alarm; it does not switch it off. (The fake's
    // one `message_queue` program answers the forwarder's query too, so this
    // asserts on the alert rather than on a count of sends.)
    const { db, project } = queueWorld({});

    await checkStuckQueue(db.sql as never);

    const stuck = sentTexts().filter((t) => t.includes("очередь застряла"));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toContain(project);
  });

  test("held messages are not forwarded to the fallback channel", async () => {
    // `forwarded_at` is set on the way out, so a message forwarded now would
    // never be forwarded again if it later got stuck for real — and it would
    // arrive as an undeliverable ten minutes before the session is allowed to
    // answer it.
    const db = new FakeSql();
    db.program("mq.forwarded_at IS NULL", {
      rows: [{ id: 5, session_id: 11, chat_id: "555", from_user: "op", content: "held", project: "helyx", age_seconds: 900 }],
    });
    db.program(SELECT_METADATA, { rows: [{ metadata: { limit: liveLimit() } }] });

    await forwardStuckMessages(db.sql as never);

    expect(http.count(SEND)).toBe(0);
    expect(db.count("SET forwarded_at")).toBe(0);
  });

  test("the limit alert says how much is waiting behind it", async () => {
    const project = uniqueName("held-proj");
    const db = new FakeSql();
    db.program(LIMIT_SCAN, { rows: [{ session_id: 11, project, metadata: { limit: liveLimit() } }] });
    db.program("COUNT(*)::int AS held", { rows: [{ held: 3 }] });

    await checkLimitedSessions(db.sql as never);

    expect(sentTexts()[0]).toContain("Сообщений придержано: 3");
  });

  test("and says nothing about it when nothing is waiting", async () => {
    const { db } = limitedWorld();

    await checkLimitedSessions(db.sql as never);

    expect(sentTexts()[0]).not.toContain("придержано");
  });
});

describe("nothing is acted on automatically", () => {
  test("no shell command is run for a limited session", async () => {
    // No provider switch, no restart, no pause. This flow makes the state
    // visible; what to do about it stays the operator's call.
    const commands: string[] = [];
    const runShell = async (cmd: string) => {
      commands.push(cmd);
      return { ok: true, output: "" };
    };
    const { db } = limitedWorld();

    await checkLimitedSessions(db.sql as never);
    await checkHungSessions(db.sql as never, runShell);

    expect(commands).toEqual([]);
    expect(db.matching("UPDATE projects")).toEqual([]);
    expect(db.matching("INSERT INTO admin_commands")).toEqual([]);
  });
});

describe("the channel is what writes the marker", () => {
  const CHAT = "-1005550009";
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  /** A StatusManager wired to a fake database, as `fold-not-hang.test.ts` builds one. */
  async function channel(sessionId: number | null = 7) {
    const { restore } = await installFakeTelegram();
    cleanups.push(restore);
    const db = new FakeSql();
    const { StatusManager } = await import("../../channel/status.ts");
    const status = new StatusManager({
      sql: db.sql as unknown as StatusContext["sql"],
      sessionId: () => sessionId,
      sessionName: () => "helyx",
      projectName: "helyx",
      token: () => "fake-token",
    });
    return { status, db };
  }

  const error = (overrides: Record<string, unknown> = {}) => ({
    kind: "session-limit" as const,
    text: "You've hit your session limit · resets 5:30pm (UTC)",
    resetsAtUtcMinutes: 17 * 60 + 30,
    uuid: "err-1",
    // Dated null by default, which is what an entry carrying no timestamp
    // gives. `ApiErrorEvent.at` is required rather than optional on purpose —
    // a producer has to decide when the error happened, because dating one by
    // read time is what lets a replayed transcript mint a live limit — so the
    // fixture states the absence instead of omitting the field. The tests that
    // are about dating override it.
    at: null as number | null,
    ...overrides,
  });

  test("a limit is written to the marker, with its kind and its reset time", async () => {
    const { status, db } = await channel();

    await status.noteApiError(error(), "/home/u/.claude/projects/slug/s.jsonl");

    const [update] = db.matching("UPDATE sessions SET metadata");
    expect(update).toBeDefined();
    const [kind, text, , resetsAt, uuid, id] = update!.values as [string, string, number, number, string, number];
    expect(kind).toBe("session-limit");
    expect(text).toContain("session limit");
    expect(uuid).toBe("err-1");
    expect(id).toBe(7);
    // Resolved here because this is the process holding a clock at the moment
    // the line was read — the parser returns a time of day and no date.
    expect(new Date(resetsAt).getUTCHours()).toBe(17);
    expect(new Date(resetsAt).getUTCMinutes()).toBe(30);
  });

  test("re-reading the same error writes nothing further", async () => {
    // `reresolve` re-reads a transcript from zero. Without the uuid key the
    // marker's `startedAt` would move forward on every pass, extending a limit
    // that had already lifted.
    const { status, db } = await channel();
    const path = "/home/u/.claude/projects/slug/s.jsonl";

    await status.noteApiError(error(), path);
    await status.noteApiError(error(), path);
    await status.noteApiError(error(), path);

    expect(db.count("UPDATE sessions SET metadata")).toBe(1);
  });

  test("an overload is not a limit and marks nothing", async () => {
    // It ends the turn and the session goes back to the prompt: there is no
    // silence to explain, and a marker would suppress the alarm for a session
    // perfectly able to answer.
    const { status, db } = await channel();

    await status.noteApiError(error({ kind: "overloaded", resetsAtUtcMinutes: null, uuid: "ov-1" }), "/p.jsonl");
    await status.noteApiError(error({ kind: "network", resetsAtUtcMinutes: null, uuid: "nw-1" }), "/p.jsonl");
    await status.noteApiError(error({ kind: "prompt-too-long", resetsAtUtcMinutes: null, uuid: "pl-1" }), "/p.jsonl");

    expect(db.count("UPDATE sessions SET metadata")).toBe(0);
  });

  test("the marker is dated by the transcript, not by the read", async () => {
    // `startedAt` used to be `Date.now()` — when the line was read. It is what
    // every expiry decision is measured from and what "resets 5:30pm" is
    // resolved against, and a transcript is a file that gets replayed from the
    // beginning.
    const { status, db } = await channel();
    const wroteAt = Date.now() - 20 * 60_000;

    await status.noteApiError(error({ at: wroteAt }), "/p.jsonl");

    const [, , startedAt] = db.matching("UPDATE sessions SET metadata")[0]!.values as [string, string, number];
    expect(startedAt).toBe(wroteAt);
  });

  test("a replayed historical error mints no limit at all", async () => {
    // The failure: `reresolve` attaches to a different transcript at offset 0
    // and replays the whole file, so a transcript carrying yesterday's "You've
    // hit your session limit · resets 5:30pm (UTC)" was read as new. Dated to
    // the read, `resolveResetAt` resolves the stated time of day to its *next*
    // occurrence — so a healthy session got a marker holding its queue and
    // muting both watchdogs until 17:30 this afternoon.
    //
    // `capturedApiErrors` cannot help: it is per-process and per-path.
    //
    // Twenty-six hours back rather than a fixed date, so the case holds
    // whenever this runs: the next occurrence of any stated time of day after
    // an instant that long ago is at most two hours ago.
    const { status, db } = await channel();

    await status.noteApiError(error({ at: Date.now() - 26 * HOUR }), "/p.jsonl");

    expect(db.count("UPDATE sessions SET metadata")).toBe(0);
  });

  test("an error from a minute ago is not history, and is marked", async () => {
    // The guard is the marker's own expiry asked one step early, so it has to
    // let through exactly what the marker would have believed.
    const { status, db } = await channel();

    await status.noteApiError(error({ at: Date.now() - 60_000 }), "/p.jsonl");

    expect(db.count("UPDATE sessions SET metadata")).toBe(1);
  });

  test("a timestamp in the future is a disagreeing clock, not a marker to drop", async () => {
    // `limitFromMarker` reads a start in the future as no limit at all, so an
    // unclamped one would discard a real limit rather than a stale one.
    const { status, db } = await channel();

    await status.noteApiError(error({ at: Date.now() + 6 * HOUR }), "/p.jsonl");

    expect(db.count("UPDATE sessions SET metadata")).toBe(1);
  });

  test("a line with no timestamp falls back to the read, as it always did", async () => {
    const { status, db } = await channel();

    await status.noteApiError(error({ at: null }), "/p.jsonl");

    expect(db.count("UPDATE sessions SET metadata")).toBe(1);
  });

  test("a limit with no session to mark is logged, not thrown on", async () => {
    // A `claude` started by hand outside the fleet hits limits like any other.
    const { status, db } = await channel(null);

    await status.noteApiError(error(), "/p.jsonl");

    expect(db.count("UPDATE sessions SET metadata")).toBe(0);
  });
});

describe("and the channel is what takes it off again", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  async function channel(sessionId: number | null = 7) {
    const { restore } = await installFakeTelegram();
    cleanups.push(restore);
    const db = new FakeSql();
    const { StatusManager } = await import("../../channel/status.ts");
    const status = new StatusManager({
      sql: db.sql as unknown as StatusContext["sql"],
      sessionId: () => sessionId,
      sessionName: () => "helyx",
      projectName: "helyx",
      token: () => "fake-token",
    });
    return { status, db };
  }

  const error = (overrides: Record<string, unknown> = {}) => ({
    kind: "session-limit" as const,
    text: "You've hit your session limit · resets 5:30pm (UTC)",
    resetsAtUtcMinutes: 17 * 60 + 30,
    uuid: "err-1",
    // See the identical factory above: `at` is required, and the fixture
    // states the absence of a date rather than omitting the field.
    at: null as number | null,
    ...overrides,
  });

  test("an answer after the limit clears the marker", async () => {
    // The failure this closes runs for five hours and says nothing. A weekly
    // limit at 09:00 states `resets 2pm`; the operator switches the project's
    // provider and the session answers again at 09:10. Nothing told the marker,
    // so the poller held every queued message until 14:00 and both watchdogs
    // stayed muted — with no second alert, because the alert is sent once per
    // event.
    const { status, db } = await channel();
    await status.noteApiError(error(), "/p.jsonl");
    db.clear();

    await status.noteSessionAnswered(Date.now() + 60_000);

    const [update] = db.matching("UPDATE sessions SET metadata");
    expect(update).toBeDefined();
    expect(update!.text).toContain("- 'limit'");
    expect(update!.values).toEqual([7]);
  });

  test("an answer written before the error is the turn that failed, not the recovery", async () => {
    // Both instants come out of the same file now, so they are comparable —
    // and the lines of one poll can carry the answer that preceded the error.
    const { status, db } = await channel();
    await status.noteApiError(error(), "/p.jsonl");
    db.clear();

    await status.noteSessionAnswered(Date.now() - 10_000);

    expect(db.count("UPDATE sessions SET metadata")).toBe(0);
  });

  test("a session that never hit a limit is not asked about on every answer", async () => {
    // A real answer arrives every few seconds for as long as a session works.
    // A query per one of them, to answer "no" for weeks at a stretch, is the
    // cost this gate exists to avoid.
    const { status, db } = await channel();

    for (let i = 0; i < 20; i++) await status.noteSessionAnswered(Date.now() + i * 1_000);

    expect(db.count("UPDATE sessions")).toBe(0);
  });

  test("and it is cleared once, not on every answer after it", async () => {
    const { status, db } = await channel();
    await status.noteApiError(error(), "/p.jsonl");
    db.clear();

    await status.noteSessionAnswered(Date.now() + 60_000);
    await status.noteSessionAnswered(Date.now() + 120_000);
    await status.noteSessionAnswered(Date.now() + 180_000);

    expect(db.count("UPDATE sessions SET metadata")).toBe(1);
  });
});

describe("a marker does not survive the restart the operator reaches for", () => {
  test("remote registration drops the limit key and keeps the fold", async () => {
    // `sessions/manager.ts` is the one statement in a position to say the
    // marker is gone: every project session is a remote session, so this
    // conflict branch is what `bun cli.ts bounce` and the restart button both
    // run through. It left `metadata` untouched, so a session restarted at
    // 09:10 under a marker reading `resets 2pm` came back able to answer and
    // was held by the poller until 14:00.
    //
    // Read out of the source for `migrations-apply.test.ts`'s reason: the
    // statement takes its `sql` from a module import, so no fixture can stand
    // in front of it, and the property is entirely in the text.
    const source = await Bun.file("sessions/manager.ts").text();
    const conflict = source.slice(source.indexOf("ON CONFLICT (project_id) WHERE source = 'remote'"));
    const clause = conflict.slice(0, conflict.indexOf("RETURNING"));

    expect(clause).toContain("- 'limit'");
    // The fold marker has to keep working beside it: `lastDurationMs` is how
    // the next fold's grace window is sized, and a fold's own `startedAt`
    // expires in four and a half minutes rather than five hours.
    expect(clause).not.toContain("- 'fold'");
    expect(clause).not.toMatch(/metadata\s*=\s*'\{\}'/);
  });
});

/**
 * The half of the fleet the hang detector could not see.
 *
 * `checkHungSessions` used to open `JOIN active_status_messages asm`, and that
 * row is written in exactly one place — `channel/status.ts`, when the channel
 * sends a Telegram status message for a turn. A turn typed straight into the
 * tmux pane produces no status message, so no row, so no session driven that way
 * could ever be found hung. Not judged healthy: invisible.
 *
 * Widening the join is the dangerous half of this flow, because every active
 * session becomes a candidate and most of them are quiet for perfectly ordinary
 * reasons. An alarm nobody believes is an alarm that is off, so the widened path
 * demands two things at once: a pane that is currently showing a spinner — the
 * session was asked to do something — and a transcript whose token counts have
 * not moved for five minutes.
 *
 * What is deliberately *not* used as that clock is the subject of half this
 * file. `sessions.last_active` is renewed unconditionally every sixty seconds by
 * `channel/session.ts:renewLease`; `sessions.pane_snapshot_at` is stamped by
 * `scripts/tmux-watchdog.ts` on every poll before any detector runs. Both are
 * heartbeats of a watcher, not of the work, and either would have produced a
 * detector that finds nothing while appearing to work.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkHungSessions,
  checkContextPressure,
  resetContextHighWater,
  resetSessionPulse,
  resetLimitAlerts,
} from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { uniqueName } from "../fixtures/unique.ts";
import { restartCallbackData } from "../../utils/supervisor-callbacks.ts";

const SESSIONS_QUERY = "SELECT s.id";
const HUNG_QUERY = "JOIN active_status_messages asm";
const SEND = "sendMessage";
const STALE_MS = 5 * 60_000;

/** A pane mid-turn, in the shape `hasActiveSpinner` recognises. */
const SPINNING = "✻ Thinking… (12s · 400 tokens)";
/** A pane at an idle prompt. */
const IDLE_PANE = "> \n  ? for shortcuts";

/**
 * The same pane a moment later: the spinner has moved and nothing else has.
 *
 * This is what a hung session looks like, and it is why the pane cannot be
 * compared raw — a photograph of an animating terminal always differs from the
 * one before it.
 */
const SPINNING_LATER = "· Thinking… (318s · 700 tokens)";

/** A pane that is printing: same spinner, more output above it. */
const printing = (lines: number) =>
  [...Array(lines)].map((_, i) => `  ${i} pass`).join("\n") + "\n" + SPINNING;

let http: FakeFetch;
let restoreFetch: () => void;

beforeEach(() => {
  resetContextHighWater();
  resetSessionPulse();
  resetLimitAlerts();
  ({ http, restore: restoreFetch } = installFakeFetch());
  http.program("api.telegram.org", () => ({ json: { ok: true, result: { message_id: 800 } } }));
});

afterEach(() => restoreFetch());

/**
 * Let the context-pressure loop see this session once, which is what gives the
 * hang detector an activity reading to measure from. Nothing new polls anything:
 * this is the loop that already tails every active session's transcript.
 */
async function observe(
  sessionId: number,
  project: string,
  tokens: number,
  pane: string,
  at: number = Date.now(),
): Promise<void> {
  const db = new FakeSql();
  db.program(SESSIONS_QUERY, {
    rows: [{
      session_id: sessionId,
      project,
      project_path: "/home/u/proj",
      model: "claude-sonnet-4-20250514",
      busy: false,
      chat_id: null,
      turn_started_at: null,
      pane_snapshot: pane,
      pane_snapshot_at: new Date(at),
      metadata: {},
    }],
  });
  // The loop stamps its observation with `Date.now()`, and every case below is
  // a claim about two observations minutes apart. Moving the clock for the
  // duration of the call is the only way to state one without sleeping — and
  // the elapsed times that matter here are five minutes long.
  const realNow = Date.now;
  Date.now = () => at;
  try {
    await checkContextPressure(db.sql as never, {
      readContext: async () => ({ tokens, window: 200_000, outputTokens: 100, activity: "● Bash: bun test" }),
      summarize: async () => "a summary",
    });
  } finally {
    Date.now = realNow;
  }
}

/** The hung query's answer for a session with no status message at all. */
function paneOnlyRow(sessionId: number, project: string, pane: string) {
  return {
    session_id: sessionId,
    project,
    project_path: "/home/u/proj",
    project_id: 3,
    key: null,
    started_at: null,
    updated_at: null,
    pane_snapshot: pane,
    pane_snapshot_at: new Date(),
  };
}

function hungWorld(rows: unknown[]): FakeSql {
  const db = new FakeSql();
  db.program(HUNG_QUERY, { rows });
  return db;
}

describe("a session driven entirely from the pane", () => {
  test("can now be found hung", async () => {
    const project = uniqueName("pane-proj");
    await observe(21, project, 100_000, SPINNING);
    const db = hungWorld([paneOnlyRow(21, project, SPINNING)]);

    await checkHungSessions(db.sql as never, undefined, Date.now() + STALE_MS + 1_000);

    expect(http.count(SEND)).toBe(1);
    expect(String((http.last(SEND)?.body as { text?: string })?.text)).toContain(project);
  });

  test("and is reported with the buttons every other hung session gets", async () => {
    const project = uniqueName("pane-proj");
    await observe(22, project, 100_000, SPINNING);
    const db = hungWorld([paneOnlyRow(22, project, SPINNING)]);

    await checkHungSessions(db.sql as never, undefined, Date.now() + STALE_MS + 1_000);

    const buttons = ((http.last(SEND)?.body as { reply_markup?: { inline_keyboard?: { callback_data: string }[][] } })
      ?.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.map((b) => b.callback_data)).toContain(restartCallbackData(3));
  });

  test("while its transcript is still moving it is working, not hung", async () => {
    // The activity signal is the point of the whole exercise: token counts that
    // move mean the model produced something, and nothing else in the schema
    // says that.
    const project = uniqueName("pane-proj");
    await observe(23, project, 100_000, SPINNING);
    const db = hungWorld([paneOnlyRow(23, project, SPINNING)]);

    await checkHungSessions(db.sql as never, undefined, Date.now() + 60_000);

    expect(http.count(SEND)).toBe(0);
  });

  test("a transcript that moved again resets the clock", async () => {
    const project = uniqueName("pane-proj");
    await observe(24, project, 100_000, SPINNING);
    await observe(24, project, 140_000, SPINNING);
    const db = hungWorld([paneOnlyRow(24, project, SPINNING)]);

    await checkHungSessions(db.sql as never, undefined, Date.now() + 60_000);

    expect(http.count(SEND)).toBe(0);
  });

  test("sitting at an idle prompt is not a candidate at all", async () => {
    // This is the false-alarm case, and the reason the widened path asks for a
    // spinner. A project nobody has typed into for a week is quiet for an
    // ordinary reason, and alerting on it would be how the operator learns to
    // ignore this topic.
    const project = uniqueName("pane-proj");
    await observe(25, project, 100_000, IDLE_PANE);
    const db = hungWorld([paneOnlyRow(25, project, IDLE_PANE)]);

    await checkHungSessions(db.sql as never, undefined, Date.now() + 60 * 60_000);

    expect(http.count(SEND)).toBe(0);
  });

  test("a long tool call is not a hang, because the pane is printing", async () => {
    // The finding this branch nearly shipped with. Between the assistant entry
    // carrying a `tool_use` and the user entry carrying its result the parent
    // transcript receives nothing — `utils/transcript-monitor.ts` documents it
    // and `pollAgents` exists to work around it — so a session running
    // `bun test`, a docker build or a subagent fan-out has frozen token counts
    // for the whole of it. On the token counts alone it was reported "не
    // отвечает" with a restart button, and because the same branch requires a
    // turning spinner the alert contradicted itself: "Claude сейчас работает"
    // beside "⚠️ Перезапустить (Claude работает!)".
    const project = uniqueName("pane-proj");
    const now = Date.now();
    await observe(27, project, 100_000, printing(3), now - STALE_MS - 60_000);
    await observe(27, project, 100_000, printing(40), now - 10_000);
    const db = hungWorld([paneOnlyRow(27, project, printing(40))]);

    await checkHungSessions(db.sql as never, undefined, now);

    expect(http.count(SEND)).toBe(0);
  });

  test("but a pane whose only movement is the spinner is still a hang", async () => {
    // The trap on the other side, and the reason the pane is normalised before
    // it is compared: a spinner animates, so a raw comparison of two captures
    // of a motionless pane always differs and nothing would ever be stale —
    // exactly the lie `last_active` tells.
    const project = uniqueName("pane-proj");
    const now = Date.now();
    await observe(28, project, 100_000, SPINNING, now - STALE_MS - 60_000);
    await observe(28, project, 100_000, SPINNING_LATER, now - 10_000);
    const db = hungWorld([paneOnlyRow(28, project, SPINNING_LATER)]);

    await checkHungSessions(db.sql as never, undefined, now);

    expect(http.count(SEND)).toBe(1);
  });

  test("and so is a session where neither the transcript nor the pane moved", async () => {
    const project = uniqueName("pane-proj");
    const now = Date.now();
    await observe(29, project, 100_000, printing(3), now - STALE_MS - 60_000);
    await observe(29, project, 100_000, printing(3), now - 10_000);
    const db = hungWorld([paneOnlyRow(29, project, printing(3))]);

    await checkHungSessions(db.sql as never, undefined, now);

    expect(http.count(SEND)).toBe(1);
  });

  test("a session nothing has read yet gets no verdict", async () => {
    // A supervisor that has just started has no evidence about any session, and
    // "no evidence" must not be answerable as "stale since the epoch".
    const project = uniqueName("pane-proj");
    const db = hungWorld([paneOnlyRow(26, project, SPINNING)]);

    await checkHungSessions(db.sql as never, undefined, Date.now() + 60 * 60_000);

    expect(http.count(SEND)).toBe(0);
  });
});

describe("the sessions that were already covered are judged as before", () => {
  /** A stale session with a status message, exactly as `supervisor-hung.test.ts` builds one. */
  function coveredRow(project: string, extra: Record<string, unknown> = {}) {
    return {
      session_id: 31,
      project,
      project_path: "/home/altsay/bots/helyx",
      project_id: 3,
      key: `asm:${project}`,
      started_at: new Date(Date.now() - 305_000),
      updated_at: new Date(Date.now() - 305_000),
      pane_snapshot: null,
      pane_snapshot_at: null,
      ...extra,
    };
  }

  test("a stale status message is still the clock, with no pane and no reading", async () => {
    const project = uniqueName("covered-proj");
    const db = hungWorld([coveredRow(project)]);

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(1);
  });

  test("an idle pane does not exempt a session whose status message is stale", async () => {
    // The spinner requirement gates the *new* path only. A session that has a
    // status message and stopped updating it is hung by the old rule, and the
    // new evidence must not be able to talk the old verdict out of firing.
    const project = uniqueName("covered-proj");
    const db = hungWorld([coveredRow(project, { pane_snapshot: IDLE_PANE, pane_snapshot_at: new Date() })]);

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(1);
  });

  test("and a fresh status message is still not hung, whatever its pane says", async () => {
    // The row would not be returned by the widened query at all — the OR's
    // second branch requires no status message — but the loop must not decide
    // otherwise if one ever arrives.
    const project = uniqueName("covered-proj");
    const db = hungWorld([
      coveredRow(project, { updated_at: new Date(), pane_snapshot: SPINNING, pane_snapshot_at: new Date() }),
    ]);

    await checkHungSessions(db.sql as never);

    expect(http.count(SEND)).toBe(0);
  });
});

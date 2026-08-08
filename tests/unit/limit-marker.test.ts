/**
 * The marker that says "not allowed to answer until 5:30pm".
 *
 * Everything here is about one property: the marker suppresses hung-session
 * detection, so it must stop being believed. A marker that outlives its limit is
 * a dead session nobody hears about — the same asymmetry `fold-marker.test.ts`
 * is built around, and the reason both files spend most of their length on
 * expiry rather than on the happy path.
 */

import { describe, test, expect } from "bun:test";
import {
  readLimitMarker,
  limitFromMarker,
  resolveResetAt,
  sessionLimit,
  startLimit,
  limitedSessions,
  limitLabel,
  resetLabel,
  LimitHold,
  LIMIT_GRACE_DEFAULT_MS,
  LIMIT_HOLD_RECHECK_MS,
  type LimitMarker,
} from "../../services/limit-marker.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

const HOUR = 60 * 60_000;

/** A session limit seen `agoMs` ago, resetting `inMs` from now. */
function marker(overrides: Partial<LimitMarker> = {}): LimitMarker {
  return {
    kind: "session-limit",
    text: "You've hit your session limit · resets 5:30pm (UTC)",
    startedAt: 1_000_000,
    resetsAt: 1_000_000 + HOUR,
    uuid: "err-1",
    ...overrides,
  };
}

describe("resolveResetAt — a time of day with no date", () => {
  /** 2026-08-08T23:50:00Z, chosen because it is the case that wraps. */
  const lateNight = Date.UTC(2026, 7, 8, 23, 50);

  test("a time still ahead today resolves to today", () => {
    const at = Date.UTC(2026, 7, 8, 14, 0);
    expect(resolveResetAt(17 * 60 + 30, at)).toBe(Date.UTC(2026, 7, 8, 17, 30));
  });

  test("a time already past resolves to tomorrow", () => {
    // The wrap. A limit hit at 23:50 that resets at 2am resets tomorrow, and
    // reading it as fourteen hours ago makes the marker expired on arrival —
    // which is the limit becoming invisible, not merely mistimed.
    expect(resolveResetAt(2 * 60, lateNight)).toBe(Date.UTC(2026, 7, 9, 2, 0));
  });

  test("the same minute counts as tomorrow, not as a zero-length limit", () => {
    const at = Date.UTC(2026, 7, 8, 17, 30);
    expect(resolveResetAt(17 * 60 + 30, at)).toBe(Date.UTC(2026, 7, 9, 17, 30));
  });

  test("no time is no instant", () => {
    expect(resolveResetAt(null, lateNight)).toBeNull();
    for (const bad of [-1, 24 * 60, Number.NaN]) {
      expect(resolveResetAt(bad, lateNight)).toBeNull();
    }
  });
});

describe("readLimitMarker — the column is JSONB and anything can be in it", () => {
  test("the marker as written comes back", () => {
    const m = readLimitMarker({ limit: { kind: "weekly-limit", text: "t", startedAt: 5, resetsAt: 9, uuid: "u" } });
    expect(m).toEqual({ kind: "weekly-limit", text: "t", startedAt: 5, resetsAt: 9, uuid: "u" });
  });

  test("a double-encoded column is still read", () => {
    // postgres.js has handed this column back as a string before — the v1.32.0
    // repair in memory/db.ts.
    const m = readLimitMarker(JSON.stringify({ limit: { kind: "session-limit", startedAt: 5 } }));
    expect(m?.startedAt).toBe(5);
  });

  test("everything that is not a marker answers null rather than throwing", () => {
    for (const value of [null, undefined, "{", "[]", {}, { limit: null }, { limit: "yes" }, { fold: {} }]) {
      expect(readLimitMarker(value)).toBeNull();
    }
  });

  test("a marker with no startedAt is not a marker", () => {
    // Every expiry decision is measured from it, so one without it would be
    // believed for ever — which is the one outcome this whole file rules out.
    expect(readLimitMarker({ limit: { kind: "session-limit", resetsAt: 9 } })).toBeNull();
  });
});

describe("limitFromMarker — when it stops being believed", () => {
  test("in force before the stated reset", () => {
    const live = limitFromMarker(marker(), 1_000_000 + HOUR / 2);
    expect(live?.kind).toBe("session-limit");
    expect(live?.elapsedMs).toBe(HOUR / 2);
    expect(live?.expiresAt).toBe(1_000_000 + HOUR);
  });

  test("gone at the stated reset, to the millisecond", () => {
    expect(limitFromMarker(marker(), 1_000_000 + HOUR)).toBeNull();
  });

  test("with no reset time it expires on the bound", () => {
    const m = marker({ resetsAt: null });
    expect(limitFromMarker(m, m.startedAt + LIMIT_GRACE_DEFAULT_MS - 1)).not.toBeNull();
    expect(limitFromMarker(m, m.startedAt + LIMIT_GRACE_DEFAULT_MS)).toBeNull();
  });

  test("a reset time in the past falls back to the bound rather than expiring at once", () => {
    // A clock that disagrees across the process boundary must not produce a
    // marker that is dead on arrival: the session is silent for a real reason
    // either way, and the bound is what the unnamed case already uses.
    const m = marker({ resetsAt: 1_000_000 - HOUR });
    expect(limitFromMarker(m, m.startedAt + 60_000)?.expiresAt).toBe(m.startedAt + LIMIT_GRACE_DEFAULT_MS);
  });

  test("a reset time a week out is not believed for a week", () => {
    const m = marker({ resetsAt: 1_000_000 + 7 * 24 * HOUR });
    expect(limitFromMarker(m, m.startedAt + LIMIT_GRACE_DEFAULT_MS)).toBeNull();
  });

  test("a start in the future opens no window", () => {
    expect(limitFromMarker(marker({ startedAt: 2_000_000 }), 1_000_000)).toBeNull();
  });

  test("no marker is no limit", () => {
    expect(limitFromMarker(null, Date.now())).toBeNull();
  });
});

describe("what crosses the process boundary", () => {
  test("the write touches the limit key and leaves the fold alone", async () => {
    // Both markers live in `sessions.metadata`. Flow 059's fold marker has to
    // keep working beside this one, and a `||` merge at the wrong level would
    // replace it.
    const db = new FakeSql();
    await startLimit(db.sql as never, 11, marker());

    const [update] = db.matching("UPDATE sessions SET metadata");
    expect(update).toBeDefined();
    expect(update!.text).toContain("'limit'");
    expect(update!.text).not.toContain("'fold'");
    expect(update!.values).toEqual([
      "session-limit",
      "You've hit your session limit · resets 5:30pm (UTC)",
      1_000_000,
      1_000_000 + HOUR,
      "err-1",
      11,
    ]);
  });

  test("the reader asks one row and answers with the live limit", async () => {
    const db = new FakeSql();
    db.program("SELECT metadata FROM sessions", { rows: [{ metadata: { limit: marker() } }] });

    const live = await sessionLimit(db.sql as never, 11, 1_000_000 + 60_000);

    expect(live?.kind).toBe("session-limit");
  });

  test("a database that will not answer is not a limit", async () => {
    // Failing closed here would turn one bad query into a permanently mute
    // watchdog — `sessionFold` makes the same choice for the same reason.
    const db = new FakeSql();
    db.program("SELECT metadata FROM sessions", { error: new Error("connection reset") });

    expect(await sessionLimit(db.sql as never, 11)).toBeNull();
  });

  test("the scan drops the sessions whose markers have expired", async () => {
    const db = new FakeSql();
    db.program("s.metadata ? 'limit'", {
      rows: [
        { session_id: 11, project: "helyx", metadata: { limit: marker() } },
        { session_id: 12, project: "vantage", metadata: { limit: marker({ startedAt: 1, resetsAt: 2 }) } },
      ],
    });

    const found = await limitedSessions(db.sql as never, 1_000_000 + 60_000);

    expect(found.map((s) => s.project)).toEqual(["helyx"]);
  });
});

describe("LimitHold — the queue waits, and then it does not", () => {
  /** A database whose one session is under the given marker. */
  function db(marker: unknown): FakeSql {
    const fake = new FakeSql();
    fake.program("SELECT metadata FROM sessions", { rows: [{ metadata: marker === null ? {} : { limit: marker } }] });
    return fake;
  }

  test("a live limit holds delivery", async () => {
    const hold = new LimitHold();
    expect(await hold.held(db(marker()).sql as never, 11, 1_000_000 + 60_000)).toBe(true);
  });

  test("no limit does not", async () => {
    const hold = new LimitHold();
    expect(await hold.held(db(null).sql as never, 11, 1_000_000 + 60_000)).toBe(false);
  });

  test("the hold lifts by itself when the reset time arrives", async () => {
    // Nobody types anything. The marker said when it lifts and the poller's own
    // loop is what notices — the release is the expiry, not a second clock.
    const fake = db(marker());
    const hold = new LimitHold();

    expect(await hold.held(fake.sql as never, 11, 1_000_000 + 60_000)).toBe(true);
    expect(await hold.held(fake.sql as never, 11, 1_000_000 + HOUR)).toBe(false);
  });

  test("a second limit hit while waiting out the first holds again", async () => {
    // Releasing blind would deliver a message straight into a fresh failure.
    const fake = new FakeSql();
    fake.programSequence("SELECT metadata FROM sessions", [
      { rows: [{ metadata: { limit: marker() } }] },
      { rows: [{ metadata: { limit: marker({ startedAt: 1_000_000 + HOUR, resetsAt: 1_000_000 + 3 * HOUR, uuid: "err-2" }) } }] },
    ]);
    const hold = new LimitHold();

    expect(await hold.held(fake.sql as never, 11, 1_000_000 + 60_000)).toBe(true);
    expect(await hold.held(fake.sql as never, 11, 1_000_000 + HOUR)).toBe(true);
  });

  test("while it holds it asks nothing further", async () => {
    // The poller runs every couple of seconds and its whole job is to be cheap.
    const fake = db(marker());
    const hold = new LimitHold();

    for (let i = 0; i < 20; i++) await hold.held(fake.sql as never, 11, 1_000_000 + 60_000 + i * 2_000);

    expect(fake.count("SELECT metadata FROM sessions")).toBe(1);
  });

  test("and an unlimited session is not asked about on every pass either", async () => {
    const fake = db(null);
    const hold = new LimitHold();

    await hold.held(fake.sql as never, 11, 1_000_000);
    await hold.held(fake.sql as never, 11, 1_000_000 + LIMIT_HOLD_RECHECK_MS - 1);
    expect(fake.count("SELECT metadata FROM sessions")).toBe(1);

    await hold.held(fake.sql as never, 11, 1_000_000 + LIMIT_HOLD_RECHECK_MS);
    expect(fake.count("SELECT metadata FROM sessions")).toBe(2);
  });

  test("a database that will not answer does not stop the queue", async () => {
    // Failing closed here would hold every message on the strength of a query
    // that never came back — the one failure worse than delivering into a
    // limited session, because it is invisible.
    const fake = new FakeSql();
    fake.program("SELECT metadata FROM sessions", { error: new Error("connection reset") });

    expect(await new LimitHold().held(fake.sql as never, 11, 1_000_000)).toBe(false);
  });

  test("a marker with no reset time still releases, on the bound", async () => {
    const fake = db(marker({ resetsAt: null }));
    const hold = new LimitHold();

    expect(await hold.held(fake.sql as never, 11, 1_000_000 + 60_000)).toBe(true);
    expect(await hold.held(fake.sql as never, 11, 1_000_000 + LIMIT_GRACE_DEFAULT_MS)).toBe(false);
  });
});

describe("what the operator reads", () => {
  test("the kind is named, not spelled as an identifier", () => {
    expect(limitLabel("weekly-limit")).toBe("недельный лимит");
    expect(limitLabel("session-limit")).toBe("лимит сессии");
  });

  test("the reset time is a wall clock, and its absence is said out loud", () => {
    expect(resetLabel(Date.UTC(2026, 7, 8, 17, 30))).toBe("до 17:30 UTC");
    expect(resetLabel(Date.UTC(2026, 7, 8, 2, 5))).toBe("до 02:05 UTC");
    expect(resetLabel(null)).toContain("не указано");
  });
});

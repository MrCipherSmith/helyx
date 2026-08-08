/**
 * The marker that says a silent session is folding, not dead.
 *
 * Compaction is bracketed by two events in two processes: the PreCompact hook
 * reaches the bot in its container before the fold, and the `compact_boundary`
 * record appears in the transcript afterwards, where the channel on the host is
 * tailing. Neither can see the other's memory, so the fact crosses a database
 * row — and every value in that row arrives as JSONB, from another process,
 * possibly written by an older version of this code.
 *
 * That is what most of this file is about. The rest is the grace window, which
 * is the only thing standing between "a fold is not a hang" and "a session that
 * died mid-fold is never reported again".
 */

import { describe, test, expect } from "bun:test";
import {
  readFoldMarker,
  foldGraceMs,
  foldFromMarker,
  sessionFold,
  startFold,
  endFold,
  startFoldForProject,
  FOLD_GRACE_DEFAULT_MS,
  FOLD_GRACE_MIN_MS,
  FOLD_GRACE_MAX_MS,
} from "../../services/fold-marker.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

/** The two folds observed in this project's own transcript on 2026-08-08. */
const OBSERVED_DURATIONS = [119544, 149137];

const SELECT_METADATA = "SELECT metadata FROM sessions";
const UPDATE_METADATA = "UPDATE sessions SET metadata";

describe("readFoldMarker", () => {
  test("the shape the writers produce", () => {
    const marker = readFoldMarker({ fold: { startedAt: 1_700_000_000_000, trigger: "auto", lastDurationMs: 119544 } });
    expect(marker).toEqual({ startedAt: 1_700_000_000_000, trigger: "auto", lastDurationMs: 119544 });
  });

  test("a column that has never been written to is not a fold", () => {
    // `metadata JSONB DEFAULT '{}'` — every session starts here.
    expect(readFoldMarker({})).toEqual({ startedAt: null, trigger: null, lastDurationMs: null });
    expect(readFoldMarker(null)).toEqual({ startedAt: null, trigger: null, lastDurationMs: null });
    expect(readFoldMarker(undefined)).toEqual({ startedAt: null, trigger: null, lastDurationMs: null });
  });

  test("a double-encoded column is still read", () => {
    // Not hypothetical: `memory/db.ts` carries a migration repairing exactly
    // this, after eight call sites in v1.32.0 stored JSON strings where JSONB
    // objects were meant.
    expect(readFoldMarker(JSON.stringify({ fold: { startedAt: 42 } })).startedAt).toBe(42);
  });

  test("garbage in the column answers no rather than throwing", () => {
    // This is read inside two watchdogs. One that throws is one that stops.
    expect(readFoldMarker("not json").startedAt).toBeNull();
    expect(readFoldMarker(7).startedAt).toBeNull();
    expect(readFoldMarker({ fold: "yes" }).startedAt).toBeNull();
    expect(readFoldMarker({ fold: { startedAt: "soon", trigger: 5, lastDurationMs: Number.NaN } })).toEqual({
      startedAt: null,
      trigger: null,
      lastDurationMs: null,
    });
  });
});

describe("foldGraceMs", () => {
  test("with no history, long enough for the folds that have been measured", () => {
    for (const observed of OBSERVED_DURATIONS) {
      expect(FOLD_GRACE_DEFAULT_MS).toBeGreaterThan(observed);
    }
    expect(foldGraceMs(null)).toBe(FOLD_GRACE_DEFAULT_MS);
  });

  test("but under the five minutes the watchdogs it silences fire at", () => {
    // The point of the default is to cover a fold, not to disable the alarm. A
    // grace window at or past the watchdog's own threshold would mean a stale
    // marker hides a genuinely dead session for as long as it survives.
    expect(FOLD_GRACE_DEFAULT_MS).toBeLessThan(5 * 60_000);
  });

  test("twice the previous fold, when there was one", () => {
    expect(foldGraceMs(119544)).toBe(119544 * 2);
  });

  test("a nonsense duration does not become a nonsense window", () => {
    // The input is written into a file by another program.
    expect(foldGraceMs(0)).toBe(FOLD_GRACE_DEFAULT_MS);
    expect(foldGraceMs(-1)).toBe(FOLD_GRACE_DEFAULT_MS);
    expect(foldGraceMs(1)).toBe(FOLD_GRACE_MIN_MS);
    expect(foldGraceMs(86_400_000)).toBe(FOLD_GRACE_MAX_MS);
  });
});

describe("foldFromMarker", () => {
  const now = 1_700_000_000_000;

  test("a fold that started a minute ago is happening", () => {
    const fold = foldFromMarker({ startedAt: now - 60_000, trigger: "auto", lastDurationMs: null }, now)!;
    expect(fold.elapsedMs).toBe(60_000);
    expect(fold.trigger).toBe("auto");
    expect(fold.graceMs).toBe(FOLD_GRACE_DEFAULT_MS);
  });

  test("both observed folds are still folds at their full duration", () => {
    for (const observed of OBSERVED_DURATIONS) {
      expect(foldFromMarker({ startedAt: now - observed, trigger: "auto", lastDurationMs: null }, now)).not.toBeNull();
    }
  });

  test("a marker past its grace window is stale, not a fold", () => {
    // The CLI died mid-compaction, or the boundary never arrived. Either way the
    // hung-session alarm has to come back.
    const marker = { startedAt: now - FOLD_GRACE_DEFAULT_MS - 1, trigger: "auto", lastDurationMs: null };
    expect(foldFromMarker(marker, now)).toBeNull();
  });

  test("the previous fold's duration widens the window", () => {
    const marker = { startedAt: now - 4 * 60_000 - 1, trigger: "auto", lastDurationMs: 149137 };
    // Stale under the default, still folding once the session has said how long
    // its folds take.
    expect(foldFromMarker({ ...marker, lastDurationMs: null }, now)).toBeNull();
    expect(foldFromMarker(marker, now)).not.toBeNull();
  });

  test("no start, and a start in the future, are both no", () => {
    expect(foldFromMarker({ startedAt: null, trigger: null, lastDurationMs: 1 }, now)).toBeNull();
    expect(foldFromMarker({ startedAt: now + 60_000, trigger: null, lastDurationMs: null }, now)).toBeNull();
  });
});

describe("sessionFold", () => {
  test("reads the row and applies the window", async () => {
    const now = 1_700_000_000_000;
    const db = new FakeSql();
    db.program(SELECT_METADATA, { rows: [{ metadata: { fold: { startedAt: now - 30_000, trigger: "manual" } } }] });

    const fold = (await sessionFold(db.sql as never, 7, now))!;
    expect(fold.trigger).toBe("manual");
    expect(fold.elapsedMs).toBe(30_000);
    expect(db.matching(SELECT_METADATA)[0]!.values).toEqual([7]);
  });

  test("a session with no row is not folding", async () => {
    const db = new FakeSql();
    expect(await sessionFold(db.sql as never, 7)).toBeNull();
  });

  test("a database that refuses is not folding either", async () => {
    // Failing closed would mute both watchdogs on one bad query — the same
    // reasoning `hasOpenQuestion` carries.
    const db = new FakeSql();
    db.program(SELECT_METADATA, { error: new Error("connection lost") });
    expect(await sessionFold(db.sql as never, 7)).toBeNull();
  });
});

describe("startFold and endFold", () => {
  test("the start is recorded with its trigger", async () => {
    const db = new FakeSql();
    await startFold(db.sql as never, 7, "auto", 1_700_000_000_000);

    const [update] = db.matching(UPDATE_METADATA);
    expect(update!.values).toEqual([1_700_000_000_000, "auto", 7]);
  });

  test("the write merges into metadata rather than replacing it", async () => {
    // `sessions.metadata` is written once at INSERT by `sessions/manager.ts` and
    // by nothing else, which is what makes this column safe to borrow — but only
    // if the borrowing is a merge. A `SET metadata = '{...}'` here would throw
    // away whatever the session was registered with.
    const db = new FakeSql();
    await startFold(db.sql as never, 7, "auto");
    await endFold(db.sql as never, 7, 119544);

    for (const update of db.matching(UPDATE_METADATA)) {
      expect(update.text).toContain("COALESCE(metadata, '{}'::jsonb) ||");
      expect(update.text).toContain("COALESCE(metadata -> 'fold', '{}'::jsonb)");
    }
  });

  test("the end clears the start and keeps the duration for next time", async () => {
    const db = new FakeSql();
    await endFold(db.sql as never, 7, 119544);

    const [update] = db.matching(UPDATE_METADATA);
    // Removed rather than zeroed, so `readFoldMarker` has one way to say "not
    // folding".
    expect(update!.text).toContain("- 'startedAt'");
    expect(update!.text).toContain("lastDurationMs");
    expect(update!.values).toEqual([119544, 7]);
  });

  test("a boundary that did not report its duration still ends the fold", async () => {
    // The format belongs to another program: a release that stops reporting
    // `durationMs` has not stopped folding.
    const db = new FakeSql();
    await endFold(db.sql as never, 7, null);

    expect(db.matching(UPDATE_METADATA)[0]!.values).toEqual([null, 7]);
  });
});

describe("startFoldForProject", () => {
  const SELECT_SESSION = "SELECT id FROM sessions";

  test("marks the active session for the path the hook was given", async () => {
    // The hook knows a project directory and a transcript file. Claude Code has
    // never heard of a session id.
    const db = new FakeSql();
    db.program(SELECT_SESSION, { rows: [{ id: 11 }] });

    expect(await startFoldForProject(db.sql as never, "/home/altsay/bots/helyx", "auto", 42)).toBe(11);
    expect(db.matching(SELECT_SESSION)[0]!.values).toEqual(["/home/altsay/bots/helyx"]);
    expect(db.matching(UPDATE_METADATA)[0]!.values).toEqual([42, "auto", 11]);
  });

  test("a path belonging to no live session marks nothing", async () => {
    // A `claude` started by hand outside the fleet folds like any other and has
    // no status message to say so on.
    const db = new FakeSql();
    db.program(SELECT_SESSION, { rows: [] });

    expect(await startFoldForProject(db.sql as never, "/tmp/scratch", "manual")).toBeNull();
    expect(db.count(UPDATE_METADATA)).toBe(0);
  });
});

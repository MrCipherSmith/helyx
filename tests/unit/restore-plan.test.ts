/**
 * Which sessions a start is allowed to bring up.
 *
 * The behaviour under test cannot be exercised on the real host without either
 * rebooting it or tearing the session half down — the two events being told
 * apart here. So the judgement lives in `sessions/restore-plan.ts` without tmux
 * or a database, and the branches are asserted here. See flow 067.
 */

import { describe, expect, test } from "bun:test";
import {
  decideStartSet,
  decideRecordAfterStart,
  encodeSnapshot,
  decodeSnapshot,
  BOOTSTRAP_PROJECT,
  type StartCandidate,
} from "../../sessions/restore-plan.ts";

const project = (name: string, autostart = false): StartCandidate => ({
  name,
  path: `/home/altsay/${name}`,
  autostart,
});

const PROJECTS: StartCandidate[] = [
  project("helyx", true),
  project("carlson-bot"),
  project("keryx"),
  project("olimpyx"),
];

const names = (d: { start: StartCandidate[] }) => d.start.map((p) => p.name);

describe("decideStartSet — cold start", () => {
  test("a new boot id starts the autostart set, whatever the snapshot holds", () => {
    const d = decideStartSet({
      bootId: "boot-b",
      storedBootId: "boot-a",
      snapshot: ["helyx", "carlson-bot", "keryx", "olimpyx"],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["helyx"]);
    expect(d.cold).toBe(true);
    expect(d.reason).toContain("rebooted");
  });

  test("no boot id recorded yet is a cold start — a first run must not restore a fleet", () => {
    const d = decideStartSet({
      bootId: "boot-a",
      storedBootId: null,
      snapshot: ["keryx"],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["helyx"]);
    expect(d.cold).toBe(true);
  });

  test("an unreadable boot id is cold, and says so — 'cannot tell' must not mean 'restore everything'", () => {
    const d = decideStartSet({
      bootId: null,
      storedBootId: "boot-a",
      snapshot: ["keryx", "olimpyx"],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["helyx"]);
    expect(d.cold).toBe(true);
    expect(d.reason).toContain("unreadable");
  });

  test("nothing flagged falls back to the bootstrap project, not to nothing", () => {
    const d = decideStartSet({
      bootId: "boot-b",
      storedBootId: "boot-a",
      snapshot: null,
      projects: PROJECTS.map((p) => ({ ...p, autostart: false })),
    });
    expect(names(d)).toEqual([BOOTSTRAP_PROJECT]);
    expect(d.reason).toContain(BOOTSTRAP_PROJECT);
  });

  test("several flags start several projects, in configured order", () => {
    const d = decideStartSet({
      bootId: "boot-b",
      storedBootId: "boot-a",
      snapshot: null,
      projects: [project("helyx", true), project("carlson-bot"), project("keryx", true)],
    });
    expect(names(d)).toEqual(["helyx", "keryx"]);
  });
});

describe("decideStartSet — restart inside the same boot", () => {
  test("the snapshot is restored exactly, and it is not the autostart set", () => {
    const d = decideStartSet({
      bootId: "boot-a",
      storedBootId: "boot-a",
      snapshot: ["keryx", "olimpyx"],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["keryx", "olimpyx"]);
    expect(d.cold).toBe(false);
  });

  test("a snapshot smaller than the autostart set still wins — a stopped helyx stays stopped", () => {
    const d = decideStartSet({
      bootId: "boot-a",
      storedBootId: "boot-a",
      snapshot: ["keryx"],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["keryx"]);
  });

  test("snapshot entries for projects that no longer exist are dropped and counted", () => {
    const d = decideStartSet({
      bootId: "boot-a",
      storedBootId: "boot-a",
      snapshot: ["keryx", "deleted-project"],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["keryx"]);
    expect(d.reason).toContain("no longer configured");
  });

  test("an empty snapshot falls back to the autostart set — a restart that starts nothing is the outage", () => {
    const d = decideStartSet({
      bootId: "boot-a",
      storedBootId: "boot-a",
      snapshot: [],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["helyx"]);
    expect(d.reason).toContain("empty");
  });

  test("a missing snapshot falls back to the autostart set", () => {
    const d = decideStartSet({
      bootId: "boot-a",
      storedBootId: "boot-a",
      snapshot: null,
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["helyx"]);
  });

  test("a snapshot matching nothing configured falls back rather than starting nothing", () => {
    const d = decideStartSet({
      bootId: "boot-a",
      storedBootId: "boot-a",
      snapshot: ["gone-1", "gone-2"],
      projects: PROJECTS,
    });
    expect(names(d)).toEqual(["helyx"]);
    expect(d.cold).toBe(false);
  });

  test("no projects at all yields an empty set rather than an invented one", () => {
    const d = decideStartSet({
      bootId: "boot-b",
      storedBootId: "boot-a",
      snapshot: null,
      projects: [],
    });
    expect(d.start).toEqual([]);
  });
});

describe("decideRecordAfterStart — what a finished start writes down", () => {
  test("a cold start that brought nothing up clears the snapshot and does not claim the boot", () => {
    // The review finding this exists for: recording the boot id while leaving
    // the previous boot's snapshot made the operator's *next* attempt a
    // restart, and it restored the whole pre-reboot fleet.
    const r = decideRecordAfterStart({ cold: true, only: false, windows: null });
    expect(r.snapshot).toEqual([]);
    expect(r.recordBootId).toBe(false);
  });

  test("a restart that brought nothing up keeps the stored snapshot", () => {
    // Nothing started, so nothing is known — and the snapshot is the only
    // record of what should come back. Clearing it here would lose the fleet.
    const r = decideRecordAfterStart({ cold: false, only: false, windows: null });
    expect(r.snapshot).toBeNull();
    expect(r.recordBootId).toBe(false);
  });

  test("a start that worked records the live windows and the boot id", () => {
    const r = decideRecordAfterStart({ cold: true, only: false, windows: ["helyx"] });
    expect(r.snapshot).toEqual(["helyx"]);
    expect(r.recordBootId).toBe(true);
  });

  test("--only records the windows but not the boot id — it is not this boot's start", () => {
    // Otherwise a single-project start right after a reboot consumes the cold
    // start, and the autostart set never comes up at all.
    const r = decideRecordAfterStart({ cold: false, only: true, windows: ["keryx"] });
    expect(r.snapshot).toEqual(["keryx"]);
    expect(r.recordBootId).toBe(false);
  });

  test("the snapshot it returns is a copy — the caller cannot mutate tmux's answer into the record", () => {
    const live = ["helyx"];
    const r = decideRecordAfterStart({ cold: true, only: false, windows: live });
    live.push("keryx");
    expect(r.snapshot).toEqual(["helyx"]);
  });
});

describe("snapshot codec", () => {
  test("round-trips the window list", () => {
    expect(decodeSnapshot(encodeSnapshot(["helyx", "keryx"]))).toEqual(["helyx", "keryx"]);
  });

  test("an empty list round-trips as empty, not as missing", () => {
    expect(decodeSnapshot(encodeSnapshot([]))).toEqual([]);
  });

  test("absent, blank and malformed records read as missing, never as empty", () => {
    expect(decodeSnapshot(null)).toBeNull();
    expect(decodeSnapshot(undefined)).toBeNull();
    expect(decodeSnapshot("   ")).toBeNull();
    expect(decodeSnapshot("{oops")).toBeNull();
    expect(decodeSnapshot('"helyx"')).toBeNull();
    expect(decodeSnapshot('{"windows":["helyx"]}')).toBeNull();
    expect(decodeSnapshot("[1,2]")).toBeNull();
  });

  test("blank entries are dropped — a trailing newline is not a window", () => {
    expect(decodeSnapshot('["helyx","","  ","keryx"]')).toEqual(["helyx", "keryx"]);
  });
});

/**
 * The inventory: which loops the supervisor actually starts.
 *
 * Eleven loops now share one daemon and one database, and every one of them was
 * added by writing a function and then remembering to register it. A function
 * written and never registered is a monitor that exists in the source and not in
 * the process — which is precisely the outage Loop 8's own comment describes,
 * where everything went quiet together and the silence read like calm.
 *
 * Nothing caught that class of mistake before this test. It reads the
 * registrations back rather than waiting for them: the intervals are minutes
 * long, and faking time would prove less than asserting the schedule directly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { startSupervisor, resetBroadcastThrottle } from "../../scripts/supervisor.ts";

interface Registered {
  ms: number;
  unrefd: boolean;
}

const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;

/** Every outbound call, so the test can prove none escaped. */
let attempted: string[];

let intervals: Registered[];
let timeouts: number[];
let runTimeouts = false;

beforeEach(() => {
  intervals = [];
  timeouts = [];
  runTimeouts = false;
  attempted = [];
  // The notify throttle (2026-08-21) is module state shared across every test
  // file in the same `bun test` process — without this, a broadcast test file
  // that ran moments earlier leaves it looking like the last post was seconds
  // ago, and the "first broadcast" this file expects gets throttled away.
  resetBroadcastThrottle();

  // `startSupervisor` runs its first checks inside an offset timeout, and one
  // of them is the status broadcast — which posts to Telegram. Found by
  // reading what running the timeouts would set in motion: with the real
  // `fetch` in place this test file was sending live messages into the
  // supervisor topic. Nothing may leave the process.
  globalThis.fetch = (async (url: unknown) => {
    attempted.push(String(url));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  // Replaced, not spied on: the real ones would schedule eleven live loops
  // against a fake database for the rest of the process.
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const entry: Registered = { ms, unrefd: false };
    intervals.push(entry);
    return { unref: () => { entry.unrefd = true; } };
  }) as unknown as typeof setInterval;

  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    timeouts.push(ms);
    // Not invoked by default. Several loops register their interval inside a
    // setTimeout to offset it, and one test below deliberately runs the
    // callbacks to see the offset loops register.
    if (runTimeouts) fn();
    return { unref: () => {} };
  }) as unknown as typeof setTimeout;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.fetch = realFetch;
});

function start(): void {
  const db = new FakeSql();
  startSupervisor(db.sql as never, async () => ({ ok: true, output: "" }));
}

describe("what startSupervisor registers", () => {
  /**
   * How many loops of each interval must exist.
   *
   * Counts, not a lower bound. Raised in review: `toBeGreaterThanOrEqual` and a
   * subset of intervals let a loop go missing while the test still passed,
   * which defeats the only thing this file is for.
   *
   * Declared rather than derived: the test's job is that nothing declared here
   * is missing from the process. An *extra* interval does not fail — that is
   * how a branch adds a loop, and this file is updated in the same commit.
   */
  const IMMEDIATE: Array<[ms: number, count: number, what: string]> = [
    [30_000, 1, "process_health heartbeat"],
    [60_000, 1, "session heartbeat"],
    [2 * 60_000, 1, "context pressure"],
    [5 * 60_000, 2, "voice cleanup and the status broadcast"],
    [10 * 60_000, 1, "Gemma health analyst"],
    [30 * 60_000, 1, "idle compaction"],
  ];

  const AFTER_OFFSETS: Array<[ms: number, count: number, what: string]> = [
    [30_000, 1, "process_health heartbeat"],
    [60_000, 3, "session heartbeat, stuck queue, recovery check"],
    [90_000, 1, "error stream"],
    [2 * 60_000, 2, "unanswered messages and context pressure"],
    [5 * 60_000, 2, "voice cleanup and the status broadcast"],
    [8 * 60_000, 1, "session pulse"],
    [10 * 60_000, 1, "Gemma health analyst"],
    [15 * 60_000, 1, "scheduled review"],
    [30 * 60_000, 2, "idle compaction and reviewer health"],
  ];

  const countsByInterval = (): Map<number, number> => {
    const counts = new Map<number, number>();
    for (const { ms } of intervals) counts.set(ms, (counts.get(ms) ?? 0) + 1);
    return counts;
  };

  test("every loop that is written is also started", () => {
    start();

    const counts = countsByInterval();
    for (const [ms, count, what] of IMMEDIATE) {
      expect({ what, registered: counts.get(ms) ?? 0 }).toEqual({ what, registered: count });
    }
  });

  test("the offset loops are scheduled, not forgotten", () => {
    // Queue, unanswered messages, the error stream, reviewer health, the
    // scheduled review and the recovery check each start after a delay so that
    // eleven loops do not hit the database on the same tick.
    start();

    expect(timeouts.length).toBeGreaterThanOrEqual(5);
    // Every offset is under two minutes: an offset large enough to look like a
    // disabled loop would be indistinguishable from one.
    for (const ms of timeouts) expect(ms).toBeLessThanOrEqual(120_000);
  });

  test("the offset loops register their intervals once their delay elapses", () => {
    // The previous test proves the delays are scheduled. This one runs them, so
    // a loop whose registration sits inside a setTimeout that is never reached
    // — or that registers nothing when it is — fails here rather than silently
    // never running in production.
    runTimeouts = true;

    start();

    const counts = countsByInterval();
    for (const [ms, count, what] of AFTER_OFFSETS) {
      expect({ what, registered: counts.get(ms) ?? 0 }).toEqual({ what, registered: count });
    }
    for (const entry of intervals) expect(entry.unrefd).toBe(true);
  });

  test("no loop holds the daemon open", () => {
    // Every timer in this module is unref'd, and there is no clearInterval
    // anywhere: unreffing is the whole of the shutdown story, so a timer that
    // missed it would keep the process alive after everything else had stopped.
    start();

    expect(intervals.length).toBeGreaterThan(0);
    for (const entry of intervals) expect(entry.unrefd).toBe(true);
  });

  test("the first status broadcast is captured by the stub, not sent", async () => {
    // The guard on the test itself, and the reason the stub exists. Running the
    // offset timeouts also runs the supervisor's first checks, and one of them
    // posts a status broadcast: before the stub was installed, this file was
    // sending live messages into the operator's supervisor topic every time the
    // suite ran. Three of them per run, measured.
    //
    // The assertion is that they arrive here rather than at Telegram: if the
    // stub is ever removed, this stops seeing them and fails.
    runTimeouts = true;

    start();
    await Bun.sleep(50); // let the fire-and-forget calls reach the stub

    expect(globalThis.fetch).not.toBe(realFetch);
    expect(attempted.some((u) => u.includes("api.telegram.org"))).toBe(true);
  });

  test("no two immediate loops share an interval by accident", () => {
    // Not a rule — voice cleanup and the status broadcast are both five
    // minutes on purpose. This pins how many such pairs exist, so a new loop
    // landing on an existing tick is a decision rather than a coincidence.
    // The pulse is eight minutes partly for this reason: five and ten were both
    // taken, and three loops posting to the same topic on the same tick is a
    // burst rather than a report.
    start();

    const shared = [...countsByInterval().entries()].filter(([, n]) => n > 1);

    expect(shared).toEqual([[5 * 60_000, 2]]);
  });
});

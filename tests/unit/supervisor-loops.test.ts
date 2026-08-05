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
import { startSupervisor } from "../../scripts/supervisor.ts";

interface Registered {
  ms: number;
  unrefd: boolean;
}

const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;

let intervals: Registered[];
let timeouts: number[];
let runTimeouts = false;

beforeEach(() => {
  intervals = [];
  timeouts = [];
  runTimeouts = false;

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
});

function start(): void {
  const db = new FakeSql();
  startSupervisor(db.sql as never, async () => ({ ok: true, output: "" }));
}

describe("what startSupervisor registers", () => {
  test("every loop that is written is also started", () => {
    start();

    // Registered immediately: session heartbeat, voice cleanup, status
    // broadcast, process-health heartbeat, idle compaction, Gemma analyst, and
    // the bot-alive probe. The rest register inside an offset timeout, which
    // this test deliberately does not run.
    expect(intervals.length).toBeGreaterThanOrEqual(6);

    const ms = intervals.map((i) => i.ms).sort((a, b) => a - b);
    expect(ms).toContain(60_000); // session heartbeat
    expect(ms).toContain(30_000); // process_health heartbeat
    expect(ms).toContain(5 * 60_000); // voice cleanup and the status broadcast
    expect(ms).toContain(30 * 60_000); // idle compaction
    expect(ms).toContain(10 * 60_000); // Gemma health analyst
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

    const ms = intervals.map((i) => i.ms);
    expect(ms).toContain(90_000); // error stream
    expect(ms).toContain(2 * 60_000); // unanswered messages
    expect(ms).toContain(15 * 60_000); // scheduled review
    expect(ms).toContain(30 * 60_000); // reviewer health, alongside idle compaction
    // Eleven loops and the recovery check, all registered.
    expect(intervals.length).toBeGreaterThanOrEqual(11);
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

  test("no two immediate loops share an interval by accident", () => {
    // Not a rule — voice cleanup and the status broadcast are both five
    // minutes on purpose. This pins how many such pairs exist, so a new loop
    // landing on an existing tick is a decision rather than a coincidence.
    start();

    const counts = new Map<number, number>();
    for (const { ms } of intervals) counts.set(ms, (counts.get(ms) ?? 0) + 1);
    const shared = [...counts.entries()].filter(([, n]) => n > 1);

    expect(shared).toEqual([[5 * 60_000, 2]]);
  });
});

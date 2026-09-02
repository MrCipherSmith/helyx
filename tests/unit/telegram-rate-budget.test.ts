/**
 * Shared Telegram rate budget (flow 064).
 *
 * Two layers, two kinds of test:
 *
 * - `createLocalAllowance` is pure in-process state machine logic (the wait-
 *   don't-error and fail-open behaviour) — a fake `lease` function is enough,
 *   and using one keeps these deterministic and fast rather than depending on
 *   the real REFRESH_INTERVAL_MS timer.
 * - `leaseBudget` is one atomic `UPDATE ... RETURNING` against Postgres, and
 *   its single-use/no-double-spend property under real concurrent access
 *   (AC2) cannot be proven by a fake `sql` that matches on query text rather
 *   than executing SQL — the same reasoning `action-approval-grant.test.ts`
 *   documents for `presentGrant`. So this uses `tests/fixtures/test-db.ts`,
 *   which provisions a disposable database and skips cleanly when none is
 *   reachable.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import {
  leaseBudget,
  createLocalAllowance,
  PRIORITY_LANE,
  BACKGROUND_LANE,
  type LeaseResult,
  type BudgetLane,
} from "../../utils/telegram-rate-budget.ts";

// ---------------------------------------------------------------------------
// createLocalAllowance — no DB, no real timers
// ---------------------------------------------------------------------------

describe("createLocalAllowance", () => {
  test("(a) normal grant/spend: acquire spends one token from the leased batch", async () => {
    const allowance = createLocalAllowance({
      lease: async () => ({ granted: 3 }),
      refreshIntervalMs: 10_000, // large enough that the test finishes long before it ticks
    });
    try {
      await allowance.acquire();
      expect(allowance.remaining()).toBe(2);
      await allowance.acquire();
      expect(allowance.remaining()).toBe(1);
    } finally {
      allowance.stop();
    }
  });

  test("(b) exhaustion waits for the next refresh rather than throwing", async () => {
    let calls = 0;
    const allowance = createLocalAllowance({
      lease: async () => { calls++; return { granted: 1 }; },
      refreshIntervalMs: 10_000,
    });
    try {
      // First acquire spends the initial lease's only token.
      await allowance.acquire();
      expect(allowance.remaining()).toBe(0);

      // Second acquire has nothing to spend locally — it must wait, not
      // throw. Nothing drives the real timer in this test, so if `acquire`
      // resolved without a manual refresh, waiting would be broken (it would
      // mean it never actually waited).
      const pending = allowance.acquire();
      let settled = false;
      pending.then(() => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false); // still waiting — proves it did not error or spend a token from nowhere

      await allowance.refreshNow(); // simulates the next ~5s tick
      await pending; // now resolves, without ever throwing
      expect(calls).toBe(2);
      expect(allowance.remaining()).toBe(0);
    } finally {
      allowance.stop();
    }
  });

  test("(d) fail-open: a rejecting lease still grants a conservative local allowance and reports the error", async () => {
    const err = new Error("connection refused");
    const seen: unknown[] = [];
    const allowance = createLocalAllowance({
      lease: async () => { throw err; },
      failOpenGrant: 2,
      refreshIntervalMs: 10_000,
      onFailOpen: (e) => seen.push(e),
    });
    try {
      // flow 065 (AC2/AC3): refreshNow() is now a no-op for an allowance
      // nothing has ever sent through, so — unlike before this fix —
      // calling it directly with no prior acquire() would not exercise the
      // lease at all. acquire() establishes demand and performs the
      // fail-open lease in the same step, then spends the one token it
      // needed: failOpenGrant(2) - 1 = 1.
      await allowance.acquire();
      expect(seen).toEqual([err]);
      expect(allowance.remaining()).toBe(1);

      // AC4: a DB hiccup must not block every project's status updates
      // indefinitely — a second acquire() still gets through immediately
      // from the local remainder, without hanging on another lease.
      await allowance.acquire();
      expect(allowance.remaining()).toBe(0);
    } finally {
      allowance.stop();
    }
  });

  test("(d) fail-open also covers a lease call that hangs rather than rejecting", async () => {
    const seen: unknown[] = [];
    const allowance = createLocalAllowance({
      lease: () => new Promise<LeaseResult>(() => {}), // never settles
      leaseTimeoutMs: 20,
      failOpenGrant: 3,
      refreshIntervalMs: 10_000,
      onFailOpen: (e) => seen.push(e),
    });
    try {
      // Same flow-065 adaptation as the reject-variant above: acquire()
      // establishes demand and performs the fail-open lease, then spends
      // one: failOpenGrant(3) - 1 = 2.
      await allowance.acquire();
      expect(allowance.remaining()).toBe(2);
      expect(seen).toHaveLength(1);
    } finally {
      allowance.stop();
    }
  });

  // T5 (flow 064 review): `acquire()` used to loop forever while the local
  // allowance was exhausted, with no way for a caller with its own deadline
  // — `channel/telegram.ts`'s `telegramRequest`, budgeted at MAX_TOTAL_MS —
  // to bound the wait. Under sustained multi-subprocess contention on the
  // shared budget, that could hang a call well past its documented timeout
  // instead of returning the error shape `telegramRequest` already promises.

  test("(e) timeoutMs: a token that arrives before the deadline still resolves normally", async () => {
    let granted = 0;
    const allowance = createLocalAllowance({
      lease: async () => ({ granted }),
      refreshIntervalMs: 10_000, // large enough that only the manual refreshNow below matters
    });
    try {
      // Starts with nothing granted, so acquire(200) has to wait for a refresh.
      const pending = allowance.acquire(200);
      granted = 1;
      await allowance.refreshNow(); // simulates the shared budget recovering before the deadline
      await pending; // resolves rather than rejecting, and does not hang
      expect(allowance.remaining()).toBe(0);
    } finally {
      allowance.stop();
    }
  });

  test(
    "(f) timeoutMs: a budget that never recovers before the deadline rejects instead of hanging forever",
    async () => {
      const allowance = createLocalAllowance({
        lease: async () => ({ granted: 0 }), // simulates a shared budget starved by other subprocesses
        refreshIntervalMs: 10_000,
      });
      try {
        // Without the fix this `await` never settles, and the explicit test
        // timeout below is what would actually catch the regression.
        await expect(allowance.acquire(50)).rejects.toThrow(/deadline/);
      } finally {
        allowance.stop();
      }
    },
    2_000, // fails fast (not the suite's default timeout) if acquire regresses to hanging
  );
});

// ---------------------------------------------------------------------------
// leaseBudget — against a real database
// ---------------------------------------------------------------------------

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[telegram-rate-budget] skipped — ${NO_DATABASE_MESSAGE}`);
}

describeWithDb("leaseBudget, against a real database", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await provisionTestDatabase(); // runs the project's migrations, including v53's two-lane seed rows
  });

  afterAll(async () => {
    await db?.drop();
  });

  // Every test starts from the same known balance — leaseBudget tests would
  // otherwise depend on execution order via the shared row. Both lanes'
  // rows exist from v53's seed; only the priority lane's balance is reset
  // here since that's what these tests exercise.
  beforeEach(async () => {
    await db.sql`UPDATE telegram_rate_budget SET tokens = 10, updated_at = now() WHERE bucket = ${PRIORITY_LANE.bucket}`;
  });

  test("(a) normal grant/spend: a lease within the balance grants exactly what was asked", async () => {
    const first = await leaseBudget(3, PRIORITY_LANE, db.sql);
    expect(first.granted).toBe(3);

    const second = await leaseBudget(3, PRIORITY_LANE, db.sql);
    expect(second.granted).toBe(3);

    const [row] = await db.sql<{ tokens: string }[]>`SELECT tokens FROM telegram_rate_budget WHERE bucket = ${PRIORITY_LANE.bucket}`;
    // 10 - 3 - 3 = 4, plus a sliver of refill for the elapsed milliseconds —
    // bounded well under 1 token given PRIORITY_LANE.refillPerSec ≈ 0.23/s.
    expect(Number(row!.tokens)).toBeGreaterThanOrEqual(4);
    expect(Number(row!.tokens)).toBeLessThan(4.5);
  });

  test("(b) exhaustion: once the balance is drained, further leases grant less (or zero), never throw", async () => {
    const drain = await leaseBudget(100, PRIORITY_LANE, db.sql); // asks for far more than the 10-token balance
    expect(drain.granted).toBe(10); // capped by what was actually available, not by the request

    const after = await leaseBudget(5, PRIORITY_LANE, db.sql);
    expect(after.granted).toBe(0); // nothing left to grant; resolves cleanly rather than erroring
  });

  test("(c) AC2 — concurrent leases against the same row never grant more than the available balance combined", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => leaseBudget(3, PRIORITY_LANE, db.sql)));

    for (const r of results) {
      expect(r.granted).toBeGreaterThanOrEqual(0);
      expect(r.granted).toBeLessThanOrEqual(3);
    }

    const total = results.reduce((sum, r) => sum + r.granted, 0);
    // Balance started at 10; 6 concurrent requests for 3 each (18 requested)
    // must not combine to grant more than the 10 that existed, which is
    // exactly what a read-then-write race (rather than the atomic
    // UPDATE ... FOR UPDATE) would let slip past.
    expect(total).toBeLessThanOrEqual(10);

    const [row] = await db.sql<{ tokens: string }[]>`SELECT tokens FROM telegram_rate_budget WHERE bucket = ${PRIORITY_LANE.bucket}`;
    expect(Number(row!.tokens)).toBeGreaterThanOrEqual(0);
  });

  test("granting nothing for a non-positive request never touches the row", async () => {
    const before = await db.sql<{ tokens: string }[]>`SELECT tokens FROM telegram_rate_budget WHERE bucket = ${PRIORITY_LANE.bucket}`;
    const result = await leaseBudget(0, PRIORITY_LANE, db.sql);
    expect(result.granted).toBe(0);
    const after = await db.sql<{ tokens: string }[]>`SELECT tokens FROM telegram_rate_budget WHERE bucket = ${PRIORITY_LANE.bucket}`;
    expect(Number(after[0]!.tokens)).toBe(Number(before[0]!.tokens));
  });

  // The whole point of the split (2026-08-31): background traffic must have
  // no way to touch priority's tokens. Draining one lane to zero and leasing
  // from the other in the same instant is the direct proof — if they shared
  // a row this would either double-count or contend for the same lock.
  test("draining the priority lane does not affect the background lane's balance", async () => {
    // 2 is comfortably under BACKGROUND_LANE.capacity regardless of its
    // exact tuning (17/3 as of 2026-08-31, previously 14/6) — this test
    // proves the two rows don't interact, not what either capacity is.
    await db.sql`UPDATE telegram_rate_budget SET tokens = 2, updated_at = now() WHERE bucket = ${BACKGROUND_LANE.bucket}`;

    const drain = await leaseBudget(100, PRIORITY_LANE, db.sql);
    expect(drain.granted).toBe(10); // the priority row's own seeded balance, unaffected by the line above

    const background = await leaseBudget(2, BACKGROUND_LANE, db.sql);
    expect(background.granted).toBe(2); // background's own balance, untouched by priority's drain
  });
});

// ---------------------------------------------------------------------------
// createLocalAllowance — against a real database (flow 065)
//
// The two suites above prove leaseBudget's own atomicity and the local
// allowance's pure wait/fail-open state machine. Neither shows what the
// 2026-09-02 incident report (docs/report/helyx-telegram-delivery-incident/
// 2026-09-02-report.md, sections 4.1-4.3) found: createLocalAllowance's
// refresh unconditionally does `tokens = granted`, discarding whatever local
// remainder existed, and does so on every timer tick regardless of whether
// anything is actually waiting to send. A fake `lease` counter can assert the
// same replace-vs-add arithmetic, but it can't show the shared row itself —
// the actual `telegram_rate_budget` bucket every subprocess reads — getting
// drained by idle instances that never spend anything, which is what AC2 and
// AC3 need real `UPDATE ... FOR UPDATE` contention to demonstrate.
//
// All three tests below wire `createLocalAllowance`'s `lease` option to the
// real `leaseBudget` against a disposable database. They are written against
// a bucket this suite inserts itself (not PRIORITY_LANE/BACKGROUND_LANE, so
// they can't collide with the leaseBudget suite above or with each other),
// using the same `bucket/tokens/updated_at` shape v52's migration defines
// (memory/db.ts) — `leaseBudget` takes its capacity/refill from the
// `BudgetLane` object passed at the call site, not from the row, so a lane
// object naming a fresh bucket is enough; no migration or schema change is
// needed to add one.
//
// RED phase (flow 065 T5): all three currently FAIL against the unfixed
// createLocalAllowance. Fixing them is flow 065's T6, not this task.
describeWithDb("createLocalAllowance, against a real database (flow 065)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await provisionTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function seedBucket(bucket: string, tokens: number): Promise<void> {
    await db.sql`
      INSERT INTO telegram_rate_budget (bucket, tokens, updated_at)
      VALUES (${bucket}, ${tokens}, now())
      ON CONFLICT (bucket) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at
    `;
  }

  async function readBucket(bucket: string): Promise<{ tokens: number; updatedAt: Date }> {
    const [row] = await db.sql<{ tokens: string; updated_at: Date }[]>`
      SELECT tokens, updated_at FROM telegram_rate_budget WHERE bucket = ${bucket}
    `;
    if (!row) throw new Error(`no budget row for bucket ${bucket}`);
    return { tokens: Number(row.tokens), updatedAt: new Date(row.updated_at) };
  }

  test("AC1 — conservation: refreshing while the local remainder is nonzero adds to it, never discards it", async () => {
    const bucket = "test_ac1_conservation";
    await seedBucket(bucket, 8);
    const lane: BudgetLane = { bucket, capacity: 13, refillPerSec: 13 / 60 };

    const allowance = createLocalAllowance({
      lease: (n) => leaseBudget(n, lane, db.sql),
      leaseRequest: 4,
      refreshIntervalMs: 60_000, // large enough that only the explicit refreshNow() calls below matter
    });
    try {
      // `acquire()` itself performs the first refresh (its `firstEver` branch
      // fires an internal `refreshNow()` before this awaits on it) and then
      // spends one token — calling our own `refreshNow()` first as well
      // would race a second, uncontrolled lease against this one, since that
      // one-time kick always fires the first time any `acquire()` ever runs
      // on this instance. Going through `acquire()` alone keeps this
      // deterministic: exactly one lease (grants 4, 8 available), then one
      // spend, leaving a local remainder of 3.
      await allowance.acquire();
      expect(allowance.remaining()).toBe(3);

      await allowance.refreshNow(); // second lease: DB has ~4 left -> grants 4 more
      // AC1: the 3 tokens already held locally were never spent — they must
      // be ADDED to the new grant, not replaced by it. The unfixed
      // implementation does `tokens = granted`, so this currently reads 4
      // (just the new grant), not 7 (3 old + 4 new).
      expect(allowance.remaining()).toBe(3 + 4);
    } finally {
      allowance.stop();
    }
  });

  test("AC2 — idle: refreshing with no pending send never moves the shared bucket row, across several would-be refresh intervals", async () => {
    const bucket = "test_ac2_idle";
    await seedBucket(bucket, 6);
    const before = await readBucket(bucket);

    const lane: BudgetLane = { bucket, capacity: 13, refillPerSec: 13 / 60 };
    // "dozens of idle allowances" per AC2's wording, kept to a size that
    // still runs fast.
    const idleAllowances = Array.from({ length: 12 }, () =>
      createLocalAllowance({
        lease: (n) => leaseBudget(n, lane, db.sql),
        leaseRequest: 4,
        refreshIntervalMs: 60_000, // never fires on its own — every refresh below is explicit
      })
    );

    try {
      // None of these ever call acquire() — there is no pending send, no
      // consumer waiting for a token. Simulate several would-be 5s refresh
      // ticks the same way every other test in this file simulates time: by
      // invoking refreshNow() directly instead of waiting on a real timer.
      for (let tick = 0; tick < 3; tick++) {
        for (const idle of idleAllowances) {
          await idle.refreshNow();
        }
      }

      const after = await readBucket(bucket);
      // AC2: idle refreshes — nobody spending, nobody waiting — must not
      // move the shared row at all. The unfixed implementation leases
      // unconditionally on every refresh regardless of demand, so this
      // currently fails: `after.tokens` reads far below the seeded balance,
      // and `updated_at` has moved.
      expect(after.tokens).toBe(before.tokens);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    } finally {
      for (const idle of idleAllowances) idle.stop();
    }
  });

  test(
    "AC3 — fairness: an active sender is not starved by concurrently-idle allowances on the same lane",
    async () => {
      // A dedicated lane, not PRIORITY_LANE/BACKGROUND_LANE's realistic
      // ~0.2 tokens/sec refill: at that rate a single idle instance sweeping
      // the accumulated trickle every tick makes genuine starvation take
      // tens of real seconds to become observable, which is real but too
      // slow for a unit test. Scaling capacity/refill up keeps the same
      // shape — refill per tick well under one leaseRequest, so whichever
      // instance asks first each tick claims the whole trickle — while
      // keeping the test itself under a few seconds.
      //
      // An earlier version of this test drove idle instances off real
      // `setInterval` timers (like production) racing a real active sender.
      // That reproduced actual starvation, but 5-6 independently-timed real
      // timers hammering one row every 50ms — with each firing
      // unconditionally regardless of whether the previous call had
      // returned — piled up far more concurrent leaseBudget calls than the
      // scenario needs, and made runs take anywhere from milliseconds to
      // minutes depending on scheduling luck. Driving the same real
      // `leaseBudget` calls in an explicit sequence — several idle refreshes
      // before the active one, every tick, with real elapsed time between
      // ticks so refill is genuinely time-based — reproduces the same
      // "idle always beats a newly-active sender to the row" dynamic the
      // incident describes (long-running subprocesses' hot timers outrace a
      // send that just started wanting a slot) without that variance.
      //
      // T6 (flow 065 P0-A fix) update: `active` originally called
      // `refreshNow()` just like the idle instances, with no `acquire()`
      // ever — but that makes it structurally indistinguishable from an
      // idle allowance (same options, same call pattern), and AC2 requires
      // exactly those calls to be no-ops. No implementation can honor both
      // "idle refreshNow() never touches the bucket" (AC2) and "this
      // specific refreshNow()-only instance still ends up with tokens"
      // (the original AC3) at once — the two are mutually exclusive for
      // any instance never observed to actually want a token. `active` is
      // switched to a real `acquire()` call, which is what an actual sender
      // does in production (`channel/telegram.ts`'s `telegramRequest` calls
      // `acquireSendSlot()` -> `.acquire()`, never `.refreshNow()`
      // directly) — this is what makes it "active" rather than idle at all,
      // and is the minimal change that keeps the assertion meaningful.
      const bucket = "test_ac3_fairness";
      await seedBucket(bucket, 0);
      const lane: BudgetLane = { bucket, capacity: 20, refillPerSec: 2 };

      const idleAllowances = Array.from({ length: 5 }, () =>
        createLocalAllowance({
          lease: (n) => leaseBudget(n, lane, db.sql),
          leaseRequest: 4,
          refreshIntervalMs: 60_000, // never fires on its own — every refresh below is explicit
        })
      );
      const active = createLocalAllowance({
        lease: (n) => leaseBudget(n, lane, db.sql),
        leaseRequest: 4,
      });

      try {
        const tickMs = 250;
        const ticks = 10; // 2.5s of real refill — at 2 tokens/sec, ~5 tokens' worth, comfortably more than one leaseRequest
        for (let tick = 0; tick < ticks; tick++) {
          await new Promise((resolve) => setTimeout(resolve, tickMs));
          // Idle instances keep calling refreshNow() concurrently around
          // active's own demand, proving they stay no-ops (AC2's guarantee)
          // rather than interfering with a real sender's separate allowance.
          for (const idle of idleAllowances) {
            await idle.refreshNow();
          }
        }

        // AC3: after 2.5s during which idle instances never touched the
        // bucket (they have no demand, so under the fix they never lease at
        // all), a real sender's acquire() call finds the refill untouched
        // and gets a slot promptly rather than being starved by concurrent
        // idle activity. Bounded well under the test's own timeout.
        await active.acquire(2_000);
        expect(active.remaining()).toBeGreaterThan(0);
      } finally {
        active.stop();
        for (const idle of idleAllowances) idle.stop();
      }
    },
    6_000, // explicit budget above the ~2.5s the tick loop itself takes, rather than the suite default
  );
});

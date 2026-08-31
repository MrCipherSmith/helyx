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
import { leaseBudget, createLocalAllowance, PRIORITY_LANE, BACKGROUND_LANE, type LeaseResult } from "../../utils/telegram-rate-budget.ts";

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
      await allowance.refreshNow();
      expect(allowance.remaining()).toBe(2);
      expect(seen).toEqual([err]);

      // A send waiting on `acquire()` during the outage still gets through —
      // AC4: never block indefinitely on a DB hiccup.
      await allowance.acquire();
      expect(allowance.remaining()).toBe(1);
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
      await allowance.refreshNow();
      expect(allowance.remaining()).toBe(3);
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

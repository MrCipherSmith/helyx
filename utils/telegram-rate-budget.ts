/**
 * Shared Telegram rate budget across concurrent `channel.ts` subprocesses.
 * Leaf module — no imports from `channel/`.
 *
 * ~10 projects (helyx, keryx, arena, goodai, …) each run their own `channel.ts`
 * subprocess, and every one of them sends to the *same* Telegram bot token and
 * chat_id — the group is one supergroup, project topics are just
 * `message_thread_id`s inside it, and Telegram enforces its rate limit per
 * chat_id, not per topic. Each subprocess already throttles its own status
 * edits and typing indicator, but none of them know about each other, so the
 * combined traffic can still exceed Telegram's real per-chat budget even when
 * every individual session is well behaved. See flow 064's description.md.
 *
 * ## Why a lease, not an acquire-per-send
 *
 * All ~10 subprocesses already share one Postgres instance (session leases
 * live there too), so the natural fix is a Postgres-backed token bucket. A
 * naive version acquires one token per outbound call — but a typing indicator
 * alone ticks every 4s per active session, and ~10 subprocesses already run
 * concurrently, so that would add a new, previously-unprecedented DB round
 * trip on every tick, with no precedent in this codebase for that call volume
 * (`memory/db.ts`'s pool is `max: 10`, sized for occasional queries, not a
 * per-tick heartbeat times ten processes).
 *
 * Instead, each subprocess leases a small batch of tokens on a ~5s timer
 * (`REFRESH_INTERVAL_MS`) — one atomic `UPDATE ... RETURNING` — and spends
 * that local allowance in-process between refreshes. This cuts the new DB
 * call volume from 1:1-with-sends to roughly 1-per-lease-window, while still
 * enforcing one real shared budget with ~5s granularity — the same order as
 * the existing 8s status-edit floor (`channel/status.ts`'s
 * `MIN_EDIT_INTERVAL_MS`), so this does not introduce a new class of lag.
 *
 * ## Why `UPDATE ... RETURNING`, not `pg_advisory_lock`
 *
 * This codebase deliberately moved away from advisory locks to a
 * lease-column + TTL pattern for session ownership, specifically to avoid
 * orphaned locks surviving a pool reconnect (CHANGELOG.md, "Lease-Based
 * Session Ownership"). `leaseBudget` follows the same atomic-`UPDATE` shape
 * already used by `utils/action-approval-grant.ts`'s `presentGrant` — the row
 * is locked for the width of one statement, never held across a round trip.
 */

import postgres from "postgres";
import { sql as defaultSql } from "../memory/db.ts";
import { channelLogger } from "../logger.ts";

/** The limit is per-chat, and there is currently exactly one chat in play. */
const BUCKET = "global";

/** Telegram's documented per-chat budget (flow 064 description.md: "~20/min"). */
const CAPACITY = 20;

/** Tokens/second — the bucket refills to CAPACITY once per minute. */
const REFILL_PER_SEC = CAPACITY / 60;

/** How often each subprocess asks Postgres for a fresh local allowance. */
const REFRESH_INTERVAL_MS = 5_000;

/** How many tokens a subprocess asks for per lease window. */
const LEASE_REQUEST = 4;

/**
 * If `leaseBudget` itself errors or hangs, grant this many local sends anyway
 * (AC4) — small and conservative, but never zero: a DB hiccup must not
 * silently mute every project's status updates.
 */
const FAILOPEN_GRANT = 2;

/** Guards a single `leaseBudget` call so a hung connection cannot delay the next refresh past REFRESH_INTERVAL_MS. */
const LEASE_TIMEOUT_MS = 3_000;

export interface LeaseResult {
  /** Tokens actually granted — always an integer, never more than requested. */
  granted: number;
}

/**
 * One atomic lease against the shared budget.
 *
 * Refills by elapsed time since `updated_at` and grants up to `n` whole
 * tokens from the result, all inside one `UPDATE ... FROM (SELECT ... FOR
 * UPDATE) RETURNING` statement — the `FOR UPDATE` matters here, not just as
 * belt-and-suspenders: the grant is computed once in the subquery and reused
 * by both the `SET` and `RETURNING` clauses, and without the row lock two
 * concurrent leases could compute their grant from the same pre-refill
 * balance and both spend it (the double-spend AC2 exists to rule out).
 *
 * `db` defaults to this project's shared pool but takes an override so a test
 * can lease against a disposable database — same shape as `runMigrations`.
 */
export async function leaseBudget(n: number, db: postgres.Sql = defaultSql): Promise<LeaseResult> {
  if (!Number.isFinite(n) || n <= 0) return { granted: 0 };

  const [row] = await db<{ granted: number }[]>`
    UPDATE telegram_rate_budget AS b
    SET
      tokens = calc.available - calc.grant,
      updated_at = now()
    FROM (
      SELECT
        LEAST(
          ${CAPACITY}::numeric,
          tokens + GREATEST(0, EXTRACT(EPOCH FROM (now() - updated_at))) * ${REFILL_PER_SEC}::numeric
        ) AS available,
        FLOOR(LEAST(
          ${n}::numeric,
          LEAST(
            ${CAPACITY}::numeric,
            tokens + GREATEST(0, EXTRACT(EPOCH FROM (now() - updated_at))) * ${REFILL_PER_SEC}::numeric
          )
        )) AS grant
      FROM telegram_rate_budget
      WHERE bucket = ${BUCKET}
      FOR UPDATE
    ) AS calc
    WHERE b.bucket = ${BUCKET}
    RETURNING calc.grant::int AS granted
  `;
  return { granted: row ? Number(row.granted) : 0 };
}

// ---------------------------------------------------------------------------
// The local, in-process allowance — what channel/telegram.ts and
// utils/typing.ts actually gate sends on. `leaseBudget` above is the DB
// primitive this spends from a batch at a time.
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`leaseBudget timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface LocalAllowanceOptions {
  /** Injectable for tests; production passes `leaseBudget` itself. */
  lease: (n: number) => Promise<LeaseResult>;
  leaseRequest?: number;
  refreshIntervalMs?: number;
  failOpenGrant?: number;
  leaseTimeoutMs?: number;
  /** Called on a fail-open — production logs it, tests assert on it. */
  onFailOpen?: (err: unknown) => void;
}

export interface LocalAllowance {
  /**
   * Resolves once a send has a reserved local token, spending it. Never
   * rejects — when the local allowance is exhausted this waits for the next
   * refresh instead of erroring, mirroring `telegramRequest`'s existing
   * 429 wait-and-retry shape so callers don't need their own retry logic.
   */
  acquire(): Promise<void>;
  /** Tokens currently held locally — for tests and diagnostics. */
  remaining(): number;
  /** Run a refresh immediately. Production relies on the timer; tests call this directly instead of waiting on real time. */
  refreshNow(): Promise<void>;
  /** Stop the refresh timer. */
  stop(): void;
}

/**
 * Build a local allowance backed by `options.lease`. Exported (rather than
 * only the process-wide singleton below) so a test can exercise the wait/
 * fail-open behaviour without a real timer or a real database.
 */
export function createLocalAllowance(options: LocalAllowanceOptions): LocalAllowance {
  const leaseRequest = options.leaseRequest ?? LEASE_REQUEST;
  const refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  const failOpenGrant = options.failOpenGrant ?? FAILOPEN_GRANT;
  const leaseTimeoutMs = options.leaseTimeoutMs ?? LEASE_TIMEOUT_MS;

  let tokens = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let waiters: Array<() => void> = [];

  function wakeWaiters(): void {
    const toWake = waiters;
    waiters = [];
    for (const wake of toWake) wake();
  }

  async function refreshNow(): Promise<void> {
    try {
      const { granted } = await withTimeout(options.lease(leaseRequest), leaseTimeoutMs);
      tokens = granted;
    } catch (err) {
      // Fail-open (AC4): a DB hiccup must not block every project's status
      // updates indefinitely. A conservative local allowance keeps sends
      // moving until the next refresh, which tries the lease again.
      tokens = failOpenGrant;
      options.onFailOpen?.(err);
    } finally {
      wakeWaiters();
    }
  }

  function ensureStarted(): void {
    if (timer) return;
    timer = setInterval(() => { void refreshNow(); }, refreshIntervalMs);
    void refreshNow();
  }

  function waitForRefresh(): Promise<void> {
    return new Promise((resolve) => { waiters.push(resolve); });
  }

  async function acquire(): Promise<void> {
    ensureStarted();
    while (tokens <= 0) {
      await waitForRefresh();
    }
    tokens -= 1;
  }

  return {
    acquire,
    remaining: () => tokens,
    refreshNow,
    stop: () => {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

let shared: LocalAllowance | null = null;

function sharedAllowance(): LocalAllowance {
  if (!shared) {
    shared = createLocalAllowance({
      lease: (n) => leaseBudget(n),
      onFailOpen: (err) => {
        channelLogger.warn({ err }, "telegram-rate-budget: leaseBudget failed — granting a conservative local allowance (fail-open)");
      },
    });
  }
  return shared;
}

/**
 * The gate `channel/telegram.ts`'s `telegramRequest` and
 * `utils/typing.ts`'s `startTypingRaw` call before each actual outbound
 * request. Lazily starts the shared refresh timer on first use, so importing
 * this module has no side effect until a send is actually attempted.
 */
export function acquireSendSlot(): Promise<void> {
  return sharedAllowance().acquire();
}

/**
 * Stand an allowance in for the process-wide shared one; the returned
 * function puts the real one back.
 *
 * A test that drives `telegramRequest`/`startTypingRaw` end to end (a
 * stubbed `fetch`, a real call into `channel/telegram.ts`) otherwise shares
 * this module's single production singleton with every other test in the
 * same `bun test` process — including its real ~5s lease window and its
 * default DB, neither of which such a test wants to depend on. Passing
 * `null` clears back to the lazily-constructed default.
 */
export function setSharedAllowanceForTests(next: LocalAllowance | null): () => void {
  const previous = shared;
  shared = next;
  return () => { shared = previous; };
}

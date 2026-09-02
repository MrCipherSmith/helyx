/**
 * The queue waits for the limit, and then it does not.
 *
 * Before this, nothing knew a session was limited, so the poller delivered into
 * it anyway: the turn failed, the stuck-queue detector fired at five minutes,
 * the hung-session detector offered a restart that could not help, and the loop
 * repeated until the limit lifted on its own. Three of the four pieces already
 * existed — `message_queue` holds an undelivered row indefinitely, the poller
 * already defers a chat that is mid-turn, and the marker now carries the reset
 * time. This is them joined up.
 *
 * The poller has never had a test, because `start()` is an infinite loop around
 * a database, an MCP client and Telegram. What is driven here is one narrow
 * thing: whether the dequeue statement is issued at all. Everything past it
 * needs the other three.
 */

import { describe, test, expect } from "bun:test";
import { MessageQueuePoller, type PollerContext } from "../../channel/poller.ts";
import type { StatusManager } from "../../channel/status.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

// The dequeue/claim statement no longer marks `delivered = true` — flow 065
// AC8 moved that write to after `mcp.notification` actually confirms
// delivery (see channel/poller.ts and tests/unit/poller-ack-before-delivered.test.ts).
// Claiming now sets `claimed_at`; this constant tracks that so this file
// keeps testing "was the dequeue statement issued at all", which is the
// only thing it ever asserted on.
const DEQUEUE = "UPDATE message_queue SET claimed_at = now()";
const SELECT_METADATA = "SELECT metadata FROM sessions";

/** A limit that started now and lifts in `inMs`. */
const limit = (inMs: number) => ({
  kind: "session-limit",
  text: "You've hit your session limit · resets 5:30pm (UTC)",
  startedAt: Date.now(),
  resetsAt: Date.now() + inMs,
  uuid: "err-1",
});

/**
 * A poller wired to a fake database and nothing else.
 *
 * The status manager only has to answer `getBusyChats` — the held path returns
 * before anything else is asked, and the delivering path is given an empty
 * dequeue so it stops at the same place.
 */
function poller(metadata: unknown): { run: () => Promise<void>; stop: () => void; db: FakeSql } {
  const db = new FakeSql();
  db.program(SELECT_METADATA, { rows: [{ metadata }] });
  db.program(DEQUEUE, { rows: [] });

  const ctx: PollerContext = {
    sql: db.sql as unknown as PollerContext["sql"],
    // Never reached: the loop only touches MCP once it has a row to deliver.
    mcp: {} as PollerContext["mcp"],
    sessionId: () => 11,
    pollIntervalMs: 5,
    // Refused fast and caught: LISTEN/NOTIFY is an optimisation over the poll
    // loop, and the loop is what this test is about.
    databaseUrl: "postgres://127.0.0.1:1/nonexistent",
  };
  const status = { getBusyChats: () => new Set<string>() } as unknown as StatusManager;

  const p = new MessageQueuePoller(ctx, status, () => {});
  return { run: () => p.start(), stop: () => p.stop(), db };
}

/** Let the loop turn over a few times. */
const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("a session under a limit", () => {
  test("holds its queue rather than delivering into a session that cannot answer", async () => {
    const { run, stop, db } = poller({ limit: limit(5 * 60_000) });
    const loop = run();

    await settle(60);
    stop();
    await loop;

    expect(db.count(DEQUEUE)).toBe(0);
    // And it asked once, not once per pass: the poll interval is seconds and
    // the answer changes at most twice a day.
    expect(db.count(SELECT_METADATA)).toBe(1);
  });

  test("delivers again when the reset time passes, with nobody typing anything", async () => {
    const { run, stop, db } = poller({ limit: limit(60) });
    const loop = run();

    await settle(250);
    stop();
    await loop;

    expect(db.count(DEQUEUE)).toBeGreaterThan(0);
  });

  test("a session with no limit is not held at all", async () => {
    const { run, stop, db } = poller({});
    const loop = run();

    await settle(60);
    stop();
    await loop;

    expect(db.count(DEQUEUE)).toBeGreaterThan(0);
  });
});

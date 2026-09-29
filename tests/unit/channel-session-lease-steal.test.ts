/**
 * The 2026-09 incident: a nested `claude` invocation — a subagent, `keryx
 * shell`, a one-shot `claude -p` run for something unrelated — inherits the
 * environment of whatever process spawned it, lands on the same project via
 * the globally-registered helyx-channel MCP server, and contends for the
 * live session's lease. `acquireLease()` only ever succeeds against an
 * expired lease, so five straight failures meant nothing more than "someone
 * else has it" — but the old code read that as "abandoned" and force-stole
 * it from a session actively serving the operator.
 *
 * `resolve()` now checks the current owner's `last_active` before stealing:
 * fresh means live, and `LiveOwnerExistsError` sends the stray invocation
 * home instead of evicting the real one.
 */

import { describe, test, expect } from "bun:test";
import { SessionManager, LiveOwnerExistsError, type SessionContext } from "../../channel/session.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

const EXISTING_QUERY = "source = 'remote'";
const ACQUIRE_QUERY = "lease_expires_at IS NULL";
const LAST_ACTIVE_QUERY = "SELECT last_active FROM sessions";
const PROJECT_QUERY = "FROM projects WHERE path";

function managerWith(db: FakeSql): SessionManager {
  const ctx: SessionContext = {
    sql: db.sql as unknown as SessionContext["sql"],
    projectName: "keryx",
    projectPath: "/home/altsay/keryx",
    channelSource: "remote",
    botApiUrl: "http://localhost:3847",
    idleTimeoutMs: 900_000,
  };
  return new SessionManager(ctx);
}

/** Both UPDATEs set `lease_owner`; only the force-steal one also sets `status`. */
const isForceStealUpdate = (text: string) => text.includes("lease_owner") && text.includes("status = 'active'");

describe("resolve() contending for an existing remote session's lease", () => {
  test("a live owner (fresh last_active) is not stolen from", async () => {
    const db = new FakeSql();
    db.program(EXISTING_QUERY, { rows: [{ id: 14 }] });
    db.program(ACQUIRE_QUERY, { rows: [] }); // every acquire attempt fails
    db.program(LAST_ACTIVE_QUERY, { rows: [{ last_active: new Date().toISOString() }] });

    const mgr = managerWith(db);
    await expect(mgr.resolve()).rejects.toThrow(LiveOwnerExistsError);

    expect(db.queries.some((q) => isForceStealUpdate(q.text))).toBe(false);
    expect(mgr.sessionId).toBeNull();
  }, 10_000);

  test("an abandoned owner (stale last_active) is still stolen from", async () => {
    const db = new FakeSql();
    db.program(EXISTING_QUERY, { rows: [{ id: 14 }] });
    db.program(ACQUIRE_QUERY, { rows: [] });
    db.program(LAST_ACTIVE_QUERY, { rows: [{ last_active: new Date(Date.now() - 10 * 60_000).toISOString() }] });
    db.program(PROJECT_QUERY, { rows: [{ id: 5 }] });

    const mgr = managerWith(db);
    const sessionId = await mgr.resolve();

    expect(sessionId).toBe(14);
    expect(mgr.sessionId).toBe(14);
    expect(db.queries.some((q) => isForceStealUpdate(q.text))).toBe(true);
  }, 10_000);

  test("no contention at all: the first attempt just succeeds", async () => {
    const db = new FakeSql();
    db.program(EXISTING_QUERY, { rows: [{ id: 9 }] });
    db.program(ACQUIRE_QUERY, { rows: [{ id: 9 }] });
    db.program(PROJECT_QUERY, { rows: [{ id: 2 }] });

    const mgr = managerWith(db);
    const sessionId = await mgr.resolve();

    expect(sessionId).toBe(9);
    // Never reached the retry loop's warning path, let alone the steal branch.
    expect(db.queries.some((q) => isForceStealUpdate(q.text))).toBe(false);
  });
});

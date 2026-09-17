/**
 * The durable half of a session status change.
 *
 * `sessions.status` is one mutable column, and the two commands that matter
 * most rewrite it in bulk — `tmuxStop` sets every remote row inactive, and so
 * does `tmux_stop`. So the record of *what was running* was destroyed by the
 * very act of stopping it, and a restart had nothing to restore from. Flow 067
 * adds `session_state_events`; these tests are what say it is actually written,
 * and written only for transitions that happened.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import { transitionSession } from "../../sessions/state-machine.ts";

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[session-state-events] skipped — ${NO_DATABASE_MESSAGE}`);
}

describeWithDb("session_state_events", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await provisionTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** A remote session in `active`, returning its id. */
  async function makeSession(clientId: string): Promise<number> {
    const [row] = await db.sql<{ id: number }[]>`
      INSERT INTO sessions (name, project_path, client_id, status, source, project)
      VALUES (${clientId}, '/tmp/x', ${clientId}, 'active', 'remote', 'probe')
      RETURNING id
    `;
    return row!.id;
  }

  test("an applied transition is recorded, with where it came from", async () => {
    const id = await makeSession(`probe-applied-${Date.now()}`);

    expect(await transitionSession(db.sql, id, "inactive", { reason: "probe", actor: "test" })).toBe(true);

    const rows = await db.sql<{
      from_status: string | null; to_status: string; reason: string | null; actor: string | null; project: string | null;
    }[]>`
      SELECT from_status, to_status, reason, actor, project FROM session_state_events WHERE session_id = ${id}
    `;
    expect(rows).toHaveLength(1);
    // `from_status` is the whole reason the UPDATE joins the pre-update row:
    // "ended up inactive" and "went from active to inactive" are different
    // facts, and only the second one says a session was stopped.
    expect(rows[0]).toMatchObject({
      from_status: "active",
      to_status: "inactive",
      reason: "probe",
      actor: "test",
      project: "probe",
    });
  });

  test("a rejected transition records nothing — an audit row for a non-event is worse than none", async () => {
    const id = await makeSession(`probe-rejected-${Date.now()}`);
    await db.sql`UPDATE sessions SET status = 'terminated' WHERE id = ${id}`;

    // terminated is terminal: the state machine allows no way out of it.
    expect(await transitionSession(db.sql, id, "active", { reason: "probe", actor: "test" })).toBe(false);

    const [count] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM session_state_events WHERE session_id = ${id}
    `;
    expect(count?.n).toBe(0);
  });

  test("each transition adds a row rather than replacing the last one", async () => {
    const id = await makeSession(`probe-history-${Date.now()}`);

    await transitionSession(db.sql, id, "inactive", { reason: "stop", actor: "test" });
    await transitionSession(db.sql, id, "active", { reason: "restore", actor: "test" });

    const rows = await db.sql<{ from_status: string | null; to_status: string }[]>`
      SELECT from_status, to_status FROM session_state_events WHERE session_id = ${id} ORDER BY id
    `;
    expect(rows.map((r) => `${r.from_status}->${r.to_status}`)).toEqual([
      "active->inactive",
      "inactive->active",
    ]);
  });
});

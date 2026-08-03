/**
 * Regression test for the v1.32.1 jsonb cast fix.
 *
 * postgres.js v3 silently strips trailing `::jsonb` casts on parameter
 * placeholders. The v1.32.0 codebase had 8 sites using the broken
 * `${JSON.stringify(x)}::jsonb` pattern → JSONB column got a scalar
 * string. This test asserts that, given the current code, a session
 * INSERT lands as a JSONB object (the operational symptom of the
 * pre-fix bug was `jsonb_typeof = 'string'`).
 *
 * Reverting any patched site to `${JSON.stringify(x)}::jsonb` makes
 * the assertion fail.
 *
 * Runs against the database `tests/preload.ts` provisions for the run, and
 * skips when there is none. It used to run against whatever `DATABASE_URL`
 * named — the developer's own database — and undo itself by deleting the rows
 * it had tagged. The tags and the cleanup are gone: the database is thrown away
 * whole, so nothing has to be remembered and nothing can be left behind.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_ENV } from "../preload.ts";
import { NO_DATABASE_MESSAGE } from "../fixtures/test-db.ts";

const EXPECTED_DB = process.env[TEST_DATABASE_ENV];
const HAS_DB = Boolean(EXPECTED_DB);

if (!HAS_DB) console.log(`[jsonb-cast] skipped — ${NO_DATABASE_MESSAGE}`);

/**
 * The connection production code uses. It is bound to the provisioned database
 * because the preload set `DATABASE_URL` before anything imported this module.
 */
async function getSql() {
  const { sql } = await import("../../memory/db.ts");
  return sql;
}

describe("v1.32.1 jsonb cast fix", () => {
  // A gate, not a sibling test.
  //
  // Everything below writes through production code paths, so "are we pointed
  // at a throwaway database?" has to be answered *before* any of them runs. As
  // an ordinary test it would merely fail while its siblings went on writing to
  // whatever DATABASE_URL really named — a red line in the report and rows in a
  // real database. A throw here stops the block.
  beforeAll(async () => {
    if (!HAS_DB) return;
    const sql = await getSql();
    const [row] = await sql<{ current: string }[]>`SELECT current_database() AS current`;
    if (row?.current !== EXPECTED_DB || !row.current.startsWith("helyx_test_")) {
      throw new Error(
        `refusing to run: connected to "${row?.current}", expected the provisioned "${EXPECTED_DB}"`,
      );
    }
  });

  test.skipIf(!HAS_DB)("session register: metadata + cli_config land as JSONB objects", async () => {
    const { sessionManager } = await import("../../sessions/manager.ts");
    const sql = await getSql();
    const session = await sessionManager.register(
      "__jsonb_cast_client__",
      "jsonb-cast-session",
      "/tmp/fake",
      { from: "regression-test", marker: "jsonb-cast" },
      { ide: "test", session_index: 1 },
    );

    const [row] = (await sql`
      SELECT
        jsonb_typeof(metadata) AS meta_t,
        jsonb_typeof(cli_config) AS cli_t,
        metadata, cli_config
      FROM sessions WHERE id = ${session.id}
    `) as any[];
    // Pre-fix: meta_t / cli_t = 'string' (scalar JSON-as-text)
    expect(row.meta_t).toBe("object");
    expect(row.cli_t).toBe("object");
    expect((row.metadata as any).marker).toBe("jsonb-cast");
    expect((row.cli_config as any).ide).toBe("test");
  });

  test.skipIf(!HAS_DB)("admin_commands.payload: project-service action lands as JSONB object", async () => {
    // services/project-service.ts emits proj_start admin commands.
    // The idempotency check `(payload->>'project_id')::int = id` only
    // works when payload is a real JSONB object, not a scalar string.
    const sql = await getSql();
    const [row] = (await sql`
      INSERT INTO admin_commands (command, payload, status)
      VALUES ('proj_start', ${sql.json({ project_id: 9999, name: "proj-test", path: "/tmp/x" })}, 'pending')
      RETURNING id
    `) as any[];

    const [check] = (await sql`
      SELECT
        jsonb_typeof(payload) AS t,
        (payload->>'project_id')::int AS pid,
        payload->>'name' AS name
      FROM admin_commands WHERE id = ${row.id}
    `) as any[];
    expect(check.t).toBe("object");
    expect(Number(check.pid)).toBe(9999);
    expect(check.name).toBe("proj-test");
  });

  test.skipIf(!HAS_DB)("project-service idempotency check actually finds duplicate via jsonb operator", async () => {
    // Pre-fix: `(payload->>'project_id')::int = ${id}` returned NULL on
    // scalar-string rows → check never found dupes → admin_commands could
    // accumulate duplicate proj_start commands. This test exercises the
    // exact predicate.
    const sql = await getSql();
    const fakeProjectId = 999_998;

    const [a] = (await sql`
      INSERT INTO admin_commands (command, payload, status)
      VALUES ('proj_start', ${sql.json({ project_id: fakeProjectId, name: "x", path: "/x" })}, 'pending')
      RETURNING id
    `) as any[];

    const matches = (await sql`
      SELECT id FROM admin_commands
      WHERE command = 'proj_start'
        AND (payload->>'project_id')::int = ${fakeProjectId}
        AND status IN ('pending', 'processing')
    `) as any[];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Contains, not "is first": the predicate has to find the row, and a
    // second pass over the same database — `bun test --rerun-each` — leaves
    // the earlier one in place. Asserting on position made the test depend on
    // how many times it had been run.
    expect(matches.map((m: any) => Number(m.id))).toContain(Number(a.id));
  });
});

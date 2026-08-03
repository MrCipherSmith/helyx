/**
 * Point the whole test run at a database of its own.
 *
 * This has to happen in a preload rather than in the test files that want it.
 * `memory/db.ts` builds its connection from `CONFIG.DATABASE_URL` at import
 * time, and every module that reaches the database goes through it — so by the
 * time any test file runs, the connection is already bound. A test that wanted
 * a different database could only get one by being the first file in the run to
 * import anything, which is not something a test can arrange.
 *
 * The consequence, before this existed, was that the database tests wrote to
 * whatever `DATABASE_URL` pointed at — in practice the developer's own
 * database — and cleaned up afterwards by tagging their rows. One failed
 * assertion short of leaving rows behind, and unable to test anything
 * destructive.
 *
 * When no Postgres is reachable, nothing is changed and `DATABASE_URL` is left
 * exactly as it was: the tests that need a database skip, and the rest of the
 * suite runs as before. A machine that has never started this project's
 * services still gets a green `bun test`.
 */

import { afterAll } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE } from "./fixtures/test-db.ts";

/** Set to the provisioned database's name when the run has one. */
export const TEST_DATABASE_ENV = "HELYX_TEST_DATABASE";

// Cleared before anything else. The marker means "this run provisioned a
// database"; inherited from a parent shell or a previous run it would mean
// nothing, and a test file reading it would take a stale value as proof of
// isolation and go on to write to whatever DATABASE_URL really names.
delete process.env[TEST_DATABASE_ENV];

const verdict = await databaseAvailable();

if (verdict.available) {
  try {
    const db = await provisionTestDatabase();
    // The server stays where it was; only the database name changes. Read
    // before it is overwritten, so a later provision still knows which server
    // to use.
    process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;
    process.env[TEST_DATABASE_ENV] = db.name;

    afterAll(async () => {
      await db.drop();
    });
  } catch (err) {
    // Provisioning failed after the server said it was reachable — a role
    // without CREATEDB, a migration that will not apply. The marker stays
    // unset and DATABASE_URL stays untouched, so database tests skip rather
    // than quietly running against the real one.
    delete process.env[TEST_DATABASE_ENV];
    console.log(`[test-db] could not provision a test database: ${err instanceof Error ? err.message : err}`);
  }
} else {
  // Not a failure. Said out loud rather than silently, because "the database
  // tests all passed" and "the database tests were all skipped" look identical
  // in a summary line.
  console.log(`[test-db] no test database for this run: ${verdict.reason}`);
  console.log(`[test-db] ${NO_DATABASE_MESSAGE}`);
}

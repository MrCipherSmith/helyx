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

const verdict = await databaseAvailable();

if (verdict.available) {
  const db = await provisionTestDatabase();
  // The server stays where it was; only the database name changes. Read before
  // it is overwritten, so a later provision still knows which server to use.
  process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;
  process.env.DATABASE_URL = db.url;
  process.env[TEST_DATABASE_ENV] = db.name;

  afterAll(async () => {
    await db.drop();
  });
} else {
  // Not a failure. Said out loud rather than silently, because "the database
  // tests all passed" and "the database tests were all skipped" look identical
  // in a summary line.
  console.log(`[test-db] no test database for this run: ${verdict.reason}`);
  console.log(`[test-db] ${NO_DATABASE_MESSAGE}`);
}

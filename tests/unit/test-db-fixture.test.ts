/**
 * The test-database fixture, tested against a real server.
 *
 * A fixture that provisions a database is only worth having if it actually
 * migrates one. "It ran without throwing" is not evidence — the migration
 * subprocess could have pointed somewhere else entirely, which is precisely
 * the failure mode the subprocess exists to rule out. So this asserts the
 * schema is there, and that it is there *in the database the fixture handed
 * back* rather than in whichever one the environment happens to name.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  databaseAvailable,
  provisionTestDatabase,
  NO_DATABASE_MESSAGE,
  type TestDatabase,
} from "../fixtures/test-db.ts";

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[test-db] skipping database tests: ${availability.reason} — ${NO_DATABASE_MESSAGE}`);
}

describe("databaseAvailable", () => {
  test("reports a verdict rather than throwing", () => {
    // The whole point: a machine that has never started Postgres gets a green
    // suite with some tests skipped, not a wall of failures about a service
    // nobody asked it to run.
    expect(typeof availability.available).toBe("boolean");
    if (!availability.available) expect(availability.reason).toBeTruthy();
  });

  test("an unreachable server is unavailable, not an exception", async () => {
    const original = process.env.TEST_DATABASE_URL;
    // Port 1 is reserved and nothing listens on it.
    process.env.TEST_DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/nothing";
    try {
      const verdict = await databaseAvailable();
      expect(verdict.available).toBe(false);
      expect(verdict.reason).toBeTruthy();
    } finally {
      if (original === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original;
    }
  });
});

describeWithDb("provisionTestDatabase", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await provisionTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  test("the database is its own, not the one DATABASE_URL names", async () => {
    const [row] = await db.sql<{ current: string }[]>`SELECT current_database() AS current`;
    expect(row!.current).toBe(db.name);
    expect(db.name).toStartWith("helyx_test_");

    const configured = new URL(process.env.DATABASE_URL ?? "postgres://x/x").pathname.slice(1);
    expect(row!.current).not.toBe(configured);
  });

  test("migrations were applied from empty", async () => {
    const [row] = await db.sql<{ v: number }[]>`SELECT max(version)::int AS v FROM schema_versions`;
    expect(row!.v).toBeGreaterThan(0);

    // A version row proves the registry ran; a table proves it did something.
    const [sessions] = await db.sql<{ present: boolean }[]>`
      SELECT to_regclass('public.sessions') IS NOT NULL AS present
    `;
    expect(sessions!.present).toBe(true);
  });

  test("migrating again is a no-op, not a second application", async () => {
    const [before] = await db.sql<{ v: number; n: number }[]>`
      SELECT max(version)::int AS v, count(*)::int AS n FROM schema_versions
    `;

    await db.remigrate();

    const [after] = await db.sql<{ v: number; n: number }[]>`
      SELECT max(version)::int AS v, count(*)::int AS n FROM schema_versions
    `;
    expect(after!.v).toBe(before!.v);
    expect(after!.n).toBe(before!.n);
  });

  test("it is disposable — a test may destroy anything in it", async () => {
    // The reason for a database of its own. Against a shared one this line is
    // unthinkable, and everything it makes testable stays untested.
    await db.sql`DROP TABLE IF EXISTS sessions CASCADE`;
    const [gone] = await db.sql<{ present: boolean }[]>`
      SELECT to_regclass('public.sessions') IS NOT NULL AS present
    `;
    expect(gone!.present).toBe(false);

    await db.remigrate();
    const [back] = await db.sql<{ present: boolean }[]>`
      SELECT to_regclass('public.sessions') IS NOT NULL AS present
    `;
    // Restoring a dropped table needs a rebuild from empty, which the version
    // table no longer reflects — so this asserts what actually happens rather
    // than what would be convenient: a re-run migrates nothing, because the
    // recorded version is still the latest.
    expect(back!.present).toBe(false);
  });
});

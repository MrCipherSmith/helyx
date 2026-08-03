/**
 * Every migration, applied to a real database, in this process.
 *
 * `memory/db.ts` is almost entirely a migration registry — forty-seven `up`
 * functions, eight hundred lines of schema. Until now the only thing that ever
 * ran them was `bun memory/db.ts` in a subprocess, which works and means every
 * one of those lines executed where no test could assert on the result and no
 * coverage tool could see it. The file read as 24% covered while its whole
 * purpose ran on every deploy.
 *
 * What this asserts is not "migrate() returned". It is that the schema the
 * application depends on actually exists afterwards: the tables it queries, the
 * columns added by later migrations, the indexes and constraints that make the
 * queries correct rather than merely successful.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import { runMigrations, MIGRATIONS, validateMigrationRegistry } from "../../memory/db.ts";

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[migrations] skipped — ${NO_DATABASE_MESSAGE}`);
}

describe("the registry, without a database", () => {
  test("versions are unique and strictly ascending", () => {
    // A duplicate version means one migration is recorded and the other never
    // runs; a non-monotonic one is skipped on any database already past it.
    expect(() => validateMigrationRegistry()).not.toThrow();
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  test("every migration is named", () => {
    // The name is what appears in schema_versions, and it is the only record
    // of what a numbered migration did.
    for (const m of MIGRATIONS) expect(m.name.trim().length).toBeGreaterThan(0);
  });
});

describeWithDb("applied to an empty database", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    // Provisioned without migrating: this suite is what migrates it.
    db = await provisionTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await db?.drop();
  });

  test("all of them run, from nothing", async () => {
    const run = await runMigrations(db.sql);

    expect(run.from).toBe(0);
    expect(run.to).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect(run.applied).toHaveLength(MIGRATIONS.length);
  });

  test("the tables the application queries are there", async () => {
    // Named explicitly rather than counted. A count passes while the one table
    // some query needs is missing; this list is the schema the rest of the
    // codebase assumes.
    const expected = [
      "sessions",
      "messages",
      "message_queue",
      "chat_sessions",
      "projects",
      "permission_requests",
      "question_requests",
      "supervisor_incidents",
      "active_status_messages",
      "admin_commands",
      "agent_created_skills",
      "providers",
      "orchestration_runs",
      "schema_versions",
    ];

    const rows = await db.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const present = new Set(rows.map((r) => r.table_name));
    for (const table of expected) expect([table, present.has(table)]).toEqual([table, true]);
  });

  test("columns added by later migrations survived to the end", async () => {
    // A migration that adds a column to a table a later one recreates is a
    // silent loss — the column is gone and nothing fails until a query needs it.
    const columns = await db.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
    `;
    const has = (table: string, column: string) =>
      columns.some((c) => c.table_name === table && c.column_name === column);

    expect(has("permission_requests", "archived_at")).toBe(true);
    expect(has("permission_requests", "status")).toBe(true);
    expect(has("permission_requests", "tmux_target")).toBe(true);
    expect(has("projects", "provider_id")).toBe(true);
    expect(has("projects", "model")).toBe(true);
    expect(has("message_queue", "forwarded_at")).toBe(true);
    expect(has("question_requests", "expired_at")).toBe(true);
  });

  test("the version table records one row per migration, by name", async () => {
    const rows = await db.sql<{ version: number; name: string }[]>`
      SELECT version, name FROM schema_versions ORDER BY version
    `;
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  test("running again applies nothing", async () => {
    // Every deploy runs this. A migration that reapplied would either fail on a
    // duplicate or, worse, quietly undo something.
    const run = await runMigrations(db.sql);
    expect(run.applied).toEqual([]);
    expect(run.from).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });

  test("a partially migrated database is brought up from where it stopped", async () => {
    // The ordinary case in production: a deploy adds migrations to a database
    // that already has the earlier ones.
    const top = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    await db.sql`DELETE FROM schema_versions WHERE version = ${top}`;

    const run = await runMigrations(db.sql);

    expect(run.from).toBe(MIGRATIONS[MIGRATIONS.length - 2]!.version);
    expect(run.applied).toEqual([MIGRATIONS[MIGRATIONS.length - 1]!.name]);
  });

  test("a migration and its version row land together", async () => {
    // Each is applied inside a transaction with its own schema_versions insert.
    // Without that, a migration that half-succeeded would be recorded as done
    // and never retried.
    const source = await Bun.file("memory/db.ts").text();
    expect(source).toContain("sql.begin(async (tx) => {");
    const begin = source.slice(source.indexOf("async function applyMigration"));
    expect(begin.slice(0, 400)).toContain("INSERT INTO schema_versions");
  });
});

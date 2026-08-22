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

  test("every table the migrations create is there, all of them", async () => {
    // The full set, not a sample. A partial list passes while the one table
    // some query needs is missing — which is the failure mode this whole test
    // exists to catch, and the first version of it checked fourteen of these.
    // Exactly what a fresh run builds — and writing it out found something:
    // the developer's own database carries six more (agent_definitions,
    // agent_events, agent_instances, agent_tasks, model_profiles,
    // model_providers) that no migration creates. Nothing in the codebase
    // references any of them, so they are leftovers from removed features
    // rather than a missing migration. A fresh install would not have them,
    // and now that is written down instead of being discovered by whoever
    // deploys next.
    const expected = [
      "action_approval_grants", "active_status_messages", "admin_commands", "agent_created_skills", "api_request_stats",
      "autonomous_actions", "aux_llm_invocations", "bot_config", "chat_sessions", "curator_pending_actions",
      "curator_runs", "matrix_violations", "memories", "message_queue",
      "messages", "orchestration_runs", "pending_replies", "permission_requests",
      "poll_sessions", "process_health", "projects", "providers",
      "question_requests", "request_logs", "schema_versions", "sessions",
      "skill_preprocess_log", "supervisor_incidents", "telegram_rate_budget",
      "transcription_stats", "voice_status_messages",
        ];

    const rows = await db.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const present = rows.map((r) => r.table_name).sort();
    expect(present).toEqual([...expected].sort());
  });

  test("the indexes the hot queries depend on exist", async () => {
    // An index is not decoration here. The supervisor sweeps the queue every
    // minute and the status loop reads active_status_messages on a timer; a
    // migration that dropped one of these leaves everything correct and slow,
    // which is the kind of regression nothing notices until production.
    const rows = await db.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const names = new Set(rows.map((r) => r.indexname));
    for (const index of [
      "idx_question_requests_open",
      "idx_permission_requests_archived",
      "idx_permissions_status",
    ]) {
      expect([index, names.has(index)]).toEqual([index, true]);
    }
  });

  test("the constraints that make the queries correct are there", async () => {
    // Primary keys and the foreign key that decides what happens to a project
    // when its provider is deleted. ON DELETE SET NULL is deliberate: removing
    // a provider falls those projects back to the default rather than deleting
    // them, and a migration that made it CASCADE would delete a project.
    const pks = await db.sql<{ table_name: string }[]>`
      SELECT tc.table_name
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
    `;
    const withPk = new Set(pks.map((r) => r.table_name));
    for (const table of ["sessions", "projects", "providers", "question_requests", "schema_versions"]) {
      expect([table, withPk.has(table)]).toEqual([table, true]);
    }

    const [fk] = await db.sql<{ delete_rule: string }[]>`
      SELECT rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
      WHERE kcu.table_name = 'projects' AND kcu.column_name = 'provider_id'
    `;
    expect(fk?.delete_rule).toBe("SET NULL");
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

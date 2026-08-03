# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected.

## Criteria

- AC1: `runMigrations(db)` takes the connection to migrate and defaults to the module's own; `migrate()` is preserved as its no-argument wrapper so the CLI and the container entrypoint are unchanged.
- AC2: `runMigrations` returns the version it started from, the version it reached, and the names it applied.
- AC3: `provisionTestDatabase` can create a database without migrating it, so a test of the migrations starts from empty.
- AC4: A test applies every migration in-process to an empty database and asserts the run covered all of them from version 0.
- AC5: A test asserts by name that the tables the application queries exist afterwards — not a count, which passes while the one table some query needs is missing.
- AC6: A test asserts that columns added by later migrations are present at the end, so a column silently lost to a later recreate is caught.
- AC7: A test asserts `schema_versions` holds one row per migration, matching both version and name.
- AC8: A test asserts a second run applies nothing, and that a database missing only the last migration is brought up by exactly that one.
- AC9: The registry tests that need no database still run without one, and the rest skip cleanly.
- AC10: `bun run typecheck`, `bun run lint` and `bun test` pass; `bun run dupes` still reports 1; `memory/db.ts` line coverage is above 90%, up from 24.31%.

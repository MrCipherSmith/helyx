# Cover the migration registry by running it in-process

Status: formalized

## Problem

`memory/db.ts` is 928 lines, of which roughly eight hundred are the migration
registry: forty-seven `up` functions that build every table the application
queries. It read as 24% covered.

Not because nothing ran it. It ran on every deploy, and the test-database
fixture from flow 010 ran it for every test session — by spawning
`bun memory/db.ts` in a subprocess. That was necessary at the time, because
`sql` binds to `CONFIG.DATABASE_URL` at import and no test could redirect it.

The consequence is that the whole schema executed where no test could assert on
the result and no coverage tool could see it. "It did not throw" was the only
thing anyone knew about a migration, and the only thing asserted anywhere was
the shape of the registry — versions unique, order ascending — never its effect.

## Expected Outcome

The migration runner takes its connection instead of assuming one:
`runMigrations(db)`, with `migrate()` as the no-argument wrapper the CLI and the
container entrypoint keep using. It returns what it did — which versions it came
from and went to, and the names it applied — because "applied nothing" and
"applied everything" are the two answers worth asserting, and a log line is not
an assertion.

A test then provisions an empty database, runs every migration in-process, and
asserts the schema that exists afterwards: the tables the application queries by
name, the columns added by later migrations, one version row per migration, and
that a second run applies nothing.

## Out of Scope

- The query functions in other files under `memory/`. This flow is the registry.
- Rollback. `down` exists on some migrations and is never invoked automatically;
  testing it is a separate question from testing that `up` builds the schema.

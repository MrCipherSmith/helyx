/**
 * A real Postgres database, provisioned for the run and dropped afterwards.
 *
 * The alternative — which this replaces — was to read `process.env.DATABASE_URL`
 * and run against whatever it pointed at, in practice the developer's own
 * database, tidying up afterwards by tagging the rows the test had inserted.
 * That is one failed assertion away from leaving rows behind and one typo away
 * from deleting the wrong ones, and it rules out testing anything destructive,
 * which is most of what a database layer does.
 *
 * With a database of its own, a test may truncate, corrupt or drop anything in
 * it. The environment variable is still where the *server* comes from; only the
 * database name is replaced.
 *
 * ## Why migrations run in a subprocess
 *
 * `memory/db.ts` builds its connection from `CONFIG.DATABASE_URL` at import
 * time, so `migrate()` is bound to whichever URL was set the first time
 * anything in the process imported that module — and `bun test` runs every file
 * in one process, where another test file may well have imported it already.
 * Setting the variable and re-importing would hand back the cached module and
 * migrate the developer's real database, which is the exact accident this
 * fixture exists to prevent.
 *
 * Running `bun memory/db.ts` as a child with the variable set uses the
 * project's own migration path with no ambiguity about which database it
 * reaches. It is slower than an in-process call, and it is the difference
 * between a fixture that is safe and one that is usually safe.
 */

import postgres from "postgres";

/** Every database this fixture creates shares this prefix, so strays are recognisable. */
const TEST_DB_PREFIX = "helyx_test_";

/** What to tell a developer whose machine has no database. */
export const NO_DATABASE_MESSAGE =
  "no Postgres reachable — start it with `docker compose up -d postgres` and set DATABASE_URL";

export interface TestDatabase {
  /** A connection to the provisioned database. */
  sql: postgres.Sql;
  /** Its connection URL. */
  url: string;
  /** Its name, for diagnostics. */
  name: string;
  /** Close the connection and drop the database. */
  drop: () => Promise<void>;
  /** Run the project's migrations against it again — for asserting idempotence. */
  remigrate: () => Promise<void>;
}

export interface Availability {
  available: boolean;
  /** Why not, when it is not — worth logging rather than swallowing. */
  reason?: string;
}

let counter = 0;

function serverUrl(): string | null {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
}

/** Swap the database name in a connection URL, keeping host, credentials and options. */
function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Can this machine run database tests?
 *
 * Returns a verdict rather than throwing. A developer who has never started
 * Postgres should get a green suite with some tests skipped, not a wall of
 * failures about a service they were not asked to run.
 */
export async function databaseAvailable(): Promise<Availability> {
  const url = serverUrl();
  if (!url) return { available: false, reason: "DATABASE_URL is not set" };

  let admin: postgres.Sql | null = null;
  try {
    admin = postgres(withDatabase(url, "postgres"), { max: 1, connect_timeout: 5, onnotice: () => {} });
    await admin`SELECT 1`;
    return { available: true };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await admin?.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Create a database for this run and migrate it.
 *
 * Throws if no server is reachable — call `databaseAvailable()` first and skip.
 * Provisioning that silently succeeded against nothing would be worse than
 * failing.
 */
export async function provisionTestDatabase(): Promise<TestDatabase> {
  const url = serverUrl();
  if (!url) throw new Error(NO_DATABASE_MESSAGE);

  const name = `${TEST_DB_PREFIX}${process.pid}_${++counter}`;
  const admin = postgres(withDatabase(url, "postgres"), { max: 1, connect_timeout: 10, onnotice: () => {} });

  try {
    await dropStrays(admin);
    // Identifiers cannot be parameterised, and the name is built here from a
    // fixed prefix, a pid and a counter — no caller supplies any part of it.
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {});
  }

  const dbUrl = withDatabase(url, name);
  await migrateInSubprocess(dbUrl, name);

  const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });

  return {
    sql,
    url: dbUrl,
    name,
    remigrate: () => migrateInSubprocess(dbUrl, name),
    drop: async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      const cleanup = postgres(withDatabase(url, "postgres"), { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 }).catch(() => {});
      }
    },
  };
}

/**
 * Drop test databases left behind by a run that died before its teardown.
 *
 * A killed process cannot clean up after itself, so the leak is self-healing
 * rather than prevented: the next run takes out the strays.
 *
 * "Stray" is decided by whether the process that created it is still alive, not
 * by whether anything is connected to it. The first version asked
 * `pg_stat_activity` and promptly dropped the database this very run had just
 * provisioned — postgres.js connects lazily, so a database nobody has queried
 * yet is indistinguishable from one whose owner is dead. The pid is in the
 * name for exactly this reason.
 */
async function dropStrays(admin: postgres.Sql): Promise<void> {
  const candidates = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE ${TEST_DB_PREFIX + "%"}
  `.catch(() => [] as { datname: string }[]);

  for (const { datname } of candidates) {
    if (!isStray(datname)) continue;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
  }
}

/** `helyx_test_<pid>_<n>` — ours, someone else's, or an orphan? */
function isStray(name: string): boolean {
  const match = name.slice(TEST_DB_PREFIX.length).match(/^(\d+)_\d+$/);
  if (!match) return false; // not a name this fixture made; leave it alone
  const pid = Number(match[1]);
  if (pid === process.pid) return false; // ours, possibly not connected yet
  return !processAlive(pid);
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Apply the project's migrations by running `memory/db.ts` against the new database. */
async function migrateInSubprocess(dbUrl: string, name: string): Promise<void> {
  const proc = Bun.spawn(["bun", "memory/db.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(`migrating ${name} failed (exit ${exitCode}): ${stderr.trim().slice(-2000)}`);
  }
}

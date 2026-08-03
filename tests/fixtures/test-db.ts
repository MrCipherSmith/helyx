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

import { hostname } from "node:os";
import postgres from "postgres";

/** Every database this fixture creates shares this prefix, so strays are recognisable. */
const TEST_DB_PREFIX = "helyx_test_";

/** What to tell a developer whose machine has no database. */
export const NO_DATABASE_MESSAGE =
  "no Postgres reachable — start it with `docker compose up -d postgres` and set DATABASE_URL";

/**
 * Hosts this fixture will create and drop databases on without being told to.
 *
 * `DATABASE_URL` is an application variable, and on some machines it points at
 * staging. This fixture issues `CREATE DATABASE` and `DROP DATABASE … WITH
 * (FORCE)`, which is not something an application variable should be able to
 * authorise by accident. A remote server has to be named deliberately, through
 * `TEST_DATABASE_URL`, and that is the whole opt-in: saying it out loud.
 *
 * `0.0.0.0` is not on the list. It is the unspecified address, not a loopback
 * one; as a destination it usually resolves to this machine and sometimes does
 * not, and "usually" is the wrong standard for something that drops databases.
 * A machine that genuinely wants it can say so in `TEST_DATABASE_URL`.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * A short, stable tag for this machine.
 *
 * The pid in a database name only means something on the host that produced it:
 * a Postgres server can be shared between machines and containers, where pid
 * 3412 is a different process for each of them, and stray cleanup would drop a
 * live run's database. The tag makes "was this mine to judge?" answerable.
 */
const HOST_TAG = shortHash(hostname());

function shortHash(value: string): string {
  // Not cryptographic — it only has to be stable and collision-shy across the
  // handful of machines that share one database server.
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

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

/**
 * May this fixture create and drop databases on the server the URL names?
 *
 * Yes if the URL was given as `TEST_DATABASE_URL` — that is someone choosing
 * this server for tests. Yes if the host is loopback. Otherwise no: an
 * inherited `DATABASE_URL` pointing at a shared or staging server must not be
 * enough to authorise DDL on it.
 */
export function permittedServer(
  url: string,
  namedExplicitly: boolean = Boolean(process.env.TEST_DATABASE_URL),
): { permitted: boolean; reason?: string } {
  if (namedExplicitly) return { permitted: true };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { permitted: false, reason: "DATABASE_URL is not a URL" };
  }
  if (LOCAL_HOSTS.has(host)) return { permitted: true };
  return {
    permitted: false,
    reason:
      `DATABASE_URL points at ${host}, which is not local. This fixture creates and drops ` +
      "databases; name a server explicitly in TEST_DATABASE_URL to allow that.",
  };
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

  const permission = permittedServer(url);
  if (!permission.permitted) return { available: false, reason: permission.reason };

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
export interface ProvisionOptions {
  /**
   * Apply the project's migrations. Default true.
   *
   * A caller that is *testing* the migrations wants an empty database and will
   * run them itself — in-process, where the result can be asserted on.
   */
  migrate?: boolean;
}

export async function provisionTestDatabase(options: ProvisionOptions = {}): Promise<TestDatabase> {
  const url = serverUrl();
  if (!url) throw new Error(NO_DATABASE_MESSAGE);

  const permission = permittedServer(url);
  if (!permission.permitted) throw new Error(permission.reason ?? "server not permitted for tests");

  const name = `${TEST_DB_PREFIX}${HOST_TAG}_${process.pid}_${++counter}`;
  const admin = postgres(withDatabase(url, "postgres"), { max: 1, connect_timeout: 10, onnotice: () => {} });

  try {
    await dropStrays(admin);
    // Identifiers cannot be parameterised, and the name is built here from a
    // fixed prefix, a host tag, a pid and a counter — no caller supplies any
    // part of it.
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {});
  }

  const dbUrl = withDatabase(url, name);
  try {
    if (options.migrate !== false) await migrateInSubprocess(dbUrl, name);
  } catch (err) {
    // The database exists and nothing yet knows how to drop it — the caller has
    // no handle, because we are throwing instead of returning one. Take it back
    // out here or it survives until some later run decides it is a stray.
    //
    // Swallowing a cleanup failure: the migration error is what the developer
    // needs to read, and letting the tidy-up throw over it would replace a
    // useful message with a less useful one. A database left behind is picked
    // up by the next run's stray sweep.
    await dropDatabase(url, name).catch(() => {});
    throw err;
  }

  const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });

  return {
    sql,
    url: dbUrl,
    name,
    remigrate: () => migrateInSubprocess(dbUrl, name),
    drop: async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      await dropDatabase(url, name);
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

/** Drop one database, connecting through the maintenance database to do it. */
async function dropDatabase(url: string, name: string): Promise<void> {
  const cleanup = postgres(withDatabase(url, "postgres"), { max: 1, onnotice: () => {} });
  try {
    await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await cleanup.end({ timeout: 5 }).catch(() => {});
  }
}

/** `helyx_test_<host>_<pid>_<n>` — ours, someone else's, or an orphan? */
export function isStray(
  name: string,
  self: { hostTag: string; pid: number } = { hostTag: HOST_TAG, pid: process.pid },
  alive: (pid: number) => boolean = processAlive,
): boolean {
  if (!name.startsWith(TEST_DB_PREFIX)) return false;
  const match = name.slice(TEST_DB_PREFIX.length).match(/^([a-z0-9]+)_(\d+)_\d+$/);
  if (!match) return false; // not a name this fixture made; leave it alone

  // Another machine's pid means nothing here — pid 3412 there is a different
  // process from pid 3412 on this host, and judging it would mean dropping a
  // live run's database.
  if (match[1] !== self.hostTag) return false;

  const pid = Number(match[2]);
  if (pid === self.pid) return false; // ours, possibly not connected to yet
  return !alive(pid);
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

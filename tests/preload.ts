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
import { installNetworkGuard } from "./fixtures/fake-fetch.ts";

/** Set to the provisioned database's name when the run has one. */
export const TEST_DATABASE_ENV = "HELYX_TEST_DATABASE";

// The network is off unless a test says otherwise.
//
// scripts/supervisor.ts reads TELEGRAM_BOT_TOKEN and SUPERVISOR_CHAT_ID from
// the environment at import — and `.env` is loaded automatically here — so the
// first test to call one of its alert paths without a fake would post to the
// real bot in the real supervisor chat. Off by default, on by asking.
installNetworkGuard();

// And the supervisor's identity is a fake one for the duration of the run.
//
// `scripts/supervisor.ts` captures these at import, so they cannot be set from
// inside a test file — by then the constants are already bound. Two reasons to
// set them here rather than leave the real values in place: a test can assert
// what an alert would have contained, which is most of what those loops do; and
// if anything ever slipped past the network guard, it would carry a token that
// authenticates as nobody.
//
// `bun test` only. The Playwright suite has its own setup and still uses the
// real credentials, which is the point of an end-to-end test.
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.SUPERVISOR_CHAT_ID = "-100999000111";
process.env.SUPERVISOR_TOPIC_ID = "7";

// And so are the voice chain's providers, for the same reason and one more.
//
// `utils/tts.ts` reads its credentials into module constants at import, so a
// test file cannot turn a provider on or off — by the time it runs, the chain
// has already been decided by whatever `.env` sits beside the checkout. That is
// not a small difference: an absent `YANDEX_API_KEY` removes a step from the
// chain, and a test that asserts what the chain did then asserts it about a
// different chain. It is why this suite was green here and red in CI for a day,
// eight failures that reproduce exactly by blanking two keys.
//
// So every credential the chain reads is set here, to the same value on every
// machine. Fake and non-empty where the provider should be reachable, empty
// where it should not — a developer who has an `OPENAI_API_KEY` gets the same
// run as one who does not.
process.env.YANDEX_API_KEY = "test-yandex-key";
process.env.YANDEX_FOLDER_ID = "test-folder-id";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.OPENAI_API_KEY = "";
process.env.OPENROUTER_API_KEY = "";

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

/**
 * The fixtures, tested.
 *
 * A fixture is code, and the failures it hides are silent by construction: a
 * fake that reports a query production never sent, or a teardown that puts the
 * fake back under the real name, does not fail — it makes other tests pass.
 * Both of those were real here, so both are pinned.
 */

import { describe, test, expect } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { isStray, permittedServer } from "../fixtures/test-db.ts";
import { installFakeTelegram, PRISTINE_TELEGRAM } from "../fixtures/fake-telegram.ts";

describe("FakeSql — a query is lazy, as postgres.js makes it", () => {
  test("building a query sends nothing", () => {
    const db = new FakeSql();
    const query = db.sql`SELECT 1 FROM nowhere`;
    expect(query.executed).toBe(false);
    // postgres.js returns a Query that has not been dispatched. If the fake
    // recorded here, a fire-and-forget statement whose `.catch()` was deleted
    // would still look sent — and utils/skill-handlers.ts has exactly one of
    // those.
    expect(db.queries).toHaveLength(0);
  });

  test("awaiting sends it", async () => {
    const db = new FakeSql();
    await db.sql`SELECT 1 FROM nowhere`;
    expect(db.count("SELECT 1 FROM nowhere")).toBe(1);
  });

  test(".catch() alone sends it — that is how fire-and-forget is written", async () => {
    const db = new FakeSql();
    db.sql`UPDATE things SET x = 1`.catch(() => {});
    await Promise.resolve();
    expect(db.count("UPDATE things")).toBe(1);
  });

  test("a query is sent once however often it is read", async () => {
    const db = new FakeSql();
    const q = db.sql`SELECT 1 FROM nowhere`;
    await q;
    await q;
    await q.catch(() => {});
    expect(db.count("SELECT 1")).toBe(1);
  });

  test("an unprogrammed query resolves to no rows rather than throwing", async () => {
    const db = new FakeSql();
    expect(await db.sql`SELECT * FROM unmentioned`).toEqual([]);
  });

  test("parameters are recorded, and the text is collapsed to one line", async () => {
    const db = new FakeSql();
    const id = "req-9";
    await db.sql`
      SELECT id
        FROM permission_requests
       WHERE id = ${id}
    `;
    expect(db.queries[0]!.text).toBe("SELECT id FROM permission_requests WHERE id = ?");
    expect(db.queries[0]!.values).toEqual([id]);
  });

  test("programming the same match twice replaces it", async () => {
    const db = new FakeSql();
    db.program("SELECT x", { rows: [{ x: 1 }] });
    db.program("SELECT x", { rows: [{ x: 2 }] });
    expect(await db.sql`SELECT x`).toEqual([{ x: 2 }]);
  });

  test("a sequence answers differently each time, then repeats the last", async () => {
    const db = new FakeSql();
    db.programSequence("SELECT response", [{ rows: [] }, { rows: [] }, { rows: [{ response: "allow" }] }]);
    expect(await db.sql`SELECT response`).toEqual([]);
    expect(await db.sql`SELECT response`).toEqual([]);
    expect(await db.sql`SELECT response`).toEqual([{ response: "allow" }]);
    expect(await db.sql`SELECT response`).toEqual([{ response: "allow" }]);
  });
});

describe("fake telegram — restoring puts the real module back", () => {
  test("teardown restores the original function, not a copy of the fake", async () => {
    const before = PRISTINE_TELEGRAM.sendTelegramMessage;
    const { restore } = await installFakeTelegram();

    const mocked = (await import("../../channel/telegram.ts")).sendTelegramMessage;
    expect(mocked).not.toBe(before);

    restore();
    const after = (await import("../../channel/telegram.ts")).sendTelegramMessage;

    // The failure this catches is silent: an ESM namespace has live bindings,
    // so a restore built from the namespace captured before mocking hands back
    // whatever is currently installed — the fake — and every later test file in
    // the process inherits it.
    expect(after).toBe(before as typeof after);
  });

  test("the other exports survive being mocked", async () => {
    const { restore } = await installFakeTelegram();
    const mod = await import("../../channel/telegram.ts");
    // Replacing a module wholesale leaves every export the fixture does not
    // name as undefined, for everyone.
    expect(typeof mod.sendTelegramPhoto).toBe("function");
    expect(typeof mod.pinTelegramMessage).toBe("function");
    restore();
  });
});

describe("test-db — which servers may be created and dropped on", () => {
  // The fixture issues CREATE DATABASE and DROP DATABASE … WITH (FORCE).
  // DATABASE_URL is an application variable and on some machines points at
  // staging, so it must not be able to authorise that by inheritance.
  const inherited = false;
  const named = true;

  test("loopback is allowed", () => {
    expect(permittedServer("postgres://u:p@localhost:5433/helyx", inherited).permitted).toBe(true);
    expect(permittedServer("postgres://u:p@127.0.0.1:5433/helyx", inherited).permitted).toBe(true);
    expect(permittedServer("postgres://u:p@[::1]:5433/helyx", inherited).permitted).toBe(true);
  });

  test("0.0.0.0 is not loopback and is refused", () => {
    // The unspecified address. As a destination it usually resolves to this
    // machine and sometimes does not, and "usually" is the wrong standard for
    // something that drops databases.
    const verdict = permittedServer("postgres://u:p@0.0.0.0:5433/helyx", inherited);
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("0.0.0.0");
  });

  test("a remote host inherited from DATABASE_URL is refused", () => {
    const verdict = permittedServer("postgres://u:p@db.staging.internal:5432/helyx", inherited);
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("TEST_DATABASE_URL");
  });

  test("the same remote host named deliberately is allowed", () => {
    // The whole opt-in is saying it out loud.
    expect(permittedServer("postgres://u:p@db.staging.internal:5432/helyx", named).permitted).toBe(true);
    expect(permittedServer("postgres://u:p@0.0.0.0:5433/helyx", named).permitted).toBe(true);
  });

  test("something that is not a URL is refused", () => {
    expect(permittedServer("not a url", inherited).permitted).toBe(false);
  });
});

describe("test-db — deciding what is a stray", () => {
  const self = { hostTag: "abc1234", pid: 500 };
  const dead = () => false;
  const alive = () => true;

  test("our own database is never a stray, connected to or not", () => {
    // The first version asked which databases had no live connections and
    // promptly dropped the one this run had just created: postgres.js connects
    // lazily, so "nothing is connected" and "the owner is dead" look identical.
    expect(isStray("helyx_test_abc1234_500_1", self, dead)).toBe(false);
  });

  test("another host's database is not ours to judge", () => {
    // pid 501 on another machine is a different process from pid 501 here, and
    // a shared server makes that a live run's database.
    expect(isStray("helyx_test_zzz9999_501_1", self, dead)).toBe(false);
  });

  test("a live process on this host keeps its database", () => {
    expect(isStray("helyx_test_abc1234_501_1", self, alive)).toBe(false);
  });

  test("a dead process on this host leaves a stray", () => {
    expect(isStray("helyx_test_abc1234_501_1", self, dead)).toBe(true);
  });

  test("anything not named by this fixture is left alone", () => {
    expect(isStray("helyx", self, dead)).toBe(false);
    expect(isStray("helyx_production", self, dead)).toBe(false);
    expect(isStray("helyx_test_backup", self, dead)).toBe(false);
    expect(isStray("helyx_test_abc1234_notapid_1", self, dead)).toBe(false);
  });
});

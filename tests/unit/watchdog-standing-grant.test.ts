/**
 * AC8 / AC9 / AC10 — the standing-grant mechanism, and AC14 — the fact that
 * nothing uses it.
 *
 * These two belong in one file on purpose. The mechanism was built to protect
 * an unattended watchdog restart that, on inspection, never existed: the
 * original `scripts/tmux-watchdog.ts` only ever alerted. The trigger was
 * withdrawn and the mechanism kept, because P-2.3 still needs an answer for
 * the day an autonomous actor does exist and that answer is better decided
 * before there is pressure to ship one.
 *
 * So AC8–AC10 prove the mechanism works, and AC14 — in the same file, where
 * anyone changing one will see the other — proves nothing in helyx currently
 * acts on it.
 *
 * The narrowness AC9 tests lives in an exact-match SQL `WHERE` clause, not in
 * application code, which is why these run against a real database rather than
 * a fake that could paper over a partial match.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import { WATCHDOG_ACTOR } from "../../scripts/grant-watchdog-standing.ts";
import {
  issueStandingGrant,
  issueOperatorGrant,
  presentGrant,
  authorizeAutonomousAction,
  type ActionFingerprint,
} from "../../utils/action-approval-grant.ts";

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[watchdog-standing-grant] skipped — ${NO_DATABASE_MESSAGE}`);
}

describe("AC14: the watchdog performs no unattended restart", () => {
  const source = readFileSync(join(import.meta.dir, "../../scripts/tmux-watchdog.ts"), "utf8");

  test("no restart is enqueued from the watchdog", () => {
    // `enqueueRestart` is how a restart reaches admin_commands. The watchdog
    // must not reach it, directly or through a helper of its own.
    expect(source).not.toContain("enqueueRestart");
    expect(source).not.toContain("restartWedgedSession");
  });

  test("the watchdog knows nothing about grants", () => {
    // The withdrawn autonomous-restart path got its foothold by importing a
    // grant constant into this file. It has no business knowing grants exist.
    expect(source).not.toContain("action-approval-grant");
    expect(source).not.toContain("StandingGrant");
    expect(source).not.toContain("authorizeAutonomousAction");
  });

  test("it still alerts — the behaviour that was there all along", () => {
    // Guards against "solving" AC14 by deleting the stall detection instead of
    // the restart that was bolted onto it.
    expect(source).toContain("sendAlert");
  });
});

describeWithDb("the standing-grant mechanism", () => {
  let db: TestDatabase;
  const PROJECT_PATH = "/home/altsay/bots/helyx-fixture-project";

  beforeAll(async () => {
    db = await provisionTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  test("WATCHDOG_ACTOR is a stable, declared identity", () => {
    expect(WATCHDOG_ACTOR).toBe("tmux-watchdog");
  });

  test("AC8: a standing grant authorizes its own fingerprint and records the use as autonomous", async () => {
    await issueStandingGrant(db.sql, {
      fingerprint: { half: "sessions", scope: PROJECT_PATH, downtime: "brief" },
      actor: WATCHDOG_ACTOR,
      authorizedBy: 100200300,
    });

    const authorized = await authorizeAutonomousAction(db.sql, WATCHDOG_ACTOR, {
      half: "sessions",
      scope: PROJECT_PATH,
      downtime: "brief",
    });
    expect(authorized.ok).toBe(true);

    // The actor and the operator who authorized it, so the morning shows what
    // acted on its own and on whose authority.
    const recorded = await db.sql`
      SELECT actor, authorized_by, half, scope, downtime FROM autonomous_actions
      WHERE actor = ${WATCHDOG_ACTOR} AND scope = ${PROJECT_PATH}
      ORDER BY acted_at DESC LIMIT 1
    `;
    expect(recorded.length).toBe(1);
    expect(Number(recorded[0]!.authorized_by)).toBe(100200300);
    expect(recorded[0]!.half).toBe("sessions");
    expect(recorded[0]!.downtime).toBe("brief");
  });

  test("AC9: refused for container/*, both/*, and sessions/all/* — three separate refusals", async () => {
    // A standing grant exists for this exact project path (from the test
    // above); none of these three may ever borrow it. This is what keeps the
    // one exemption from single-use from becoming a hole.
    const wider: ActionFingerprint[] = [
      { half: "container", scope: "all", downtime: "brief" },
      { half: "both", scope: "all", downtime: "full" },
      { half: "sessions", scope: "all", downtime: "brief" },
    ];

    for (const fingerprint of wider) {
      const result = await authorizeAutonomousAction(db.sql, WATCHDOG_ACTOR, fingerprint);
      // The fingerprint is in the assertion so a failure names which one passed.
      expect([fingerprint, result.ok]).toEqual([fingerprint, false]);
    }
  });

  test("AC9: an actor holding no grant at all is refused", async () => {
    const result = await authorizeAutonomousAction(db.sql, "some-other-actor", {
      half: "sessions",
      scope: PROJECT_PATH,
      downtime: "brief",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-standing-grant");
  });

  test("AC10: a standing grant is not consumed by use; an operator grant is", async () => {
    const path = "/tmp/reused-standing-grant";
    await issueStandingGrant(db.sql, {
      fingerprint: { half: "sessions", scope: path, downtime: "brief" },
      actor: WATCHDOG_ACTOR,
      authorizedBy: 1,
    });
    const fp: ActionFingerprint = { half: "sessions", scope: path, downtime: "brief" };

    const first = await authorizeAutonomousAction(db.sql, WATCHDOG_ACTOR, fp);
    const second = await authorizeAutonomousAction(db.sql, WATCHDOG_ACTOR, fp);
    expect([first.ok, second.ok]).toEqual([true, true]);

    // The contrast is the point: the same repeated use of an operator grant
    // fails the second time.
    const operator = await issueOperatorGrant(db.sql, {
      fingerprint: fp,
      issuedBy: 100200300,
      pendingCommand: "proj_stop",
      statedTo: "перезапустить сессии этого проекта",
    });
    const firstUse = await presentGrant(db.sql, operator.grantId, fp);
    const secondUse = await presentGrant(db.sql, operator.grantId, fp);
    expect(firstUse.ok).toBe(true);
    expect(secondUse.ok).toBe(false);
  });
});

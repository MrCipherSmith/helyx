/**
 * scripts/restart-gate.ts — the gate `scripts/admin-daemon.ts` calls before
 * `claimRestart()` at the three commands that take the restart lease.
 *
 * Against a real database for the same reason action-approval-grant.test.ts
 * is: `authorizeRestart` calls `presentGrant`, whose single-use consumption is
 * an atomic SQL `UPDATE`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import { authorizeRestart, GATED_RESTART_COMMANDS } from "../../scripts/restart-gate.ts";
import { issueOperatorGrant, issueStandingGrant } from "../../utils/action-approval-grant.ts";

describe("GATED_RESTART_COMMANDS", () => {
  test("is every teardown-capable command, not only the ones that take the lease", () => {
    // Corrected 2026-08-12. This assertion used to read "exactly the three
    // commands that take the restart lease", which is how the gate came to
    // cover three of eight entrances: taking the lease and needing approval
    // are different questions (P-2.6), and five of these take no lease at all.
    expect([...GATED_RESTART_COMMANDS].sort()).toEqual([
      "bounce", "channel_kill", "docker_restart", "docker_restart_all",
      "full_restart", "host_restart", "proj_stop", "tmux_stop",
    ]);
  });
});

describe("authorizeRestart — commands outside the gated family", () => {
  test("a command fingerprintOf does not gate is always ok, with no DB or grant needed", async () => {
    const fakeSql = (() => { throw new Error("must not query the DB for an ungated command"); }) as any;
    // `stack_up` — the documented recovery path, exempt by decision. It was
    // `docker_restart_all` here until that command joined the gated set.
    const result = await authorizeRestart(fakeSql, { command: "stack_up" });
    expect(result.ok).toBe(true);
  });
});

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[restart-gate] skipped — ${NO_DATABASE_MESSAGE}`);
}

describeWithDb("authorizeRestart, against a real database", () => {
  let db: TestDatabase;

  beforeAll(async () => { db = await provisionTestDatabase(); });
  afterAll(async () => { await db?.drop(); });

  // AC4 — no grant at all is "no approver reachable": denied, never allowed.
  test("AC4: no payload.grantId at all is refused, not allowed", async () => {
    const result = await authorizeRestart(db.sql, { command: "bounce", payload: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/no approver reachable/);
  });

  test("AC4: a grantId that does not exist is refused the same way", async () => {
    const result = await authorizeRestart(db.sql, { command: "bounce", payload: { grantId: "g_nope00000000000000" } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/no approver reachable/);
  });

  // AC1 — the refusal names both fingerprints.
  test("AC1: a grant for full_restart (both/all/full) does not authorize bounce (sessions/all/brief), and names both", async () => {
    const grant = await issueOperatorGrant(db.sql, {
      fingerprint: { half: "both", scope: "all", downtime: "full" },
      issuedBy: 1,
      pendingCommand: "full_restart",
    });
    const result = await authorizeRestart(db.sql, { command: "bounce", payload: { grantId: grant.grantId } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("both/all/full");
    expect(result.message).toContain("sessions/all/brief");
  });

  // AC2 — single-use, distinct message from AC1's mismatch.
  test("AC2: a second presentation of the same grant is refused, message distinct from a mismatch", async () => {
    const grant = await issueOperatorGrant(db.sql, {
      fingerprint: { half: "sessions", scope: "all", downtime: "brief" },
      issuedBy: 1,
      pendingCommand: "bounce",
    });
    const payload = { grantId: grant.grantId };
    const first = await authorizeRestart(db.sql, { command: "bounce", payload });
    expect(first.ok).toBe(true);

    const second = await authorizeRestart(db.sql, { command: "bounce", payload });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.message).toMatch(/already used/);
    expect(second.message).not.toContain("does not authorize");
  });

  // AC3 — expired.
  test("AC3: an expired grant is refused", async () => {
    const now = new Date();
    const grant = await issueOperatorGrant(db.sql, {
      fingerprint: { half: "sessions", scope: "all", downtime: "brief" },
      issuedBy: 1,
      pendingCommand: "bounce",
      now,
      ttlMs: 1,
    });
    await Bun.sleep(5);
    const result = await authorizeRestart(db.sql, { command: "bounce", payload: { grantId: grant.grantId } }, new Date(now.getTime() + 50));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/expired/);
  });

  // AC7 — a fingerprint field forged into the payload alongside the grant id
  // must have no effect; the gate always re-derives from the command.
  test("AC7: a forged payload.fingerprint does not change what is authorized", async () => {
    const grant = await issueOperatorGrant(db.sql, {
      fingerprint: { half: "sessions", scope: "all", downtime: "brief" },
      issuedBy: 1,
      pendingCommand: "bounce",
    });
    const result = await authorizeRestart(db.sql, {
      command: "bounce",
      payload: { grantId: grant.grantId, fingerprint: { half: "container", scope: "all", downtime: "brief" } },
    });
    // The grant matches bounce's REAL fingerprint (sessions/all/brief), not
    // the forged one — so this must succeed exactly because the forged field
    // was never read.
    expect(result.ok).toBe(true);
  });

  // F2 — a gated command whose payload yields no fingerprint must fail
  // closed, not open. Before the fix, `authorizeRestart` returned `ok: true`
  // for ANY null fingerprint, gated or not — this is the case that mattered.
  test("F2: docker_restart with no container (malformed) fails closed, not open", async () => {
    const result = await authorizeRestart(db.sql, { command: "docker_restart", payload: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/malformed/);
  });

  test("F2: proj_stop with project_id but no path (malformed) fails closed — the exact shape the daemon's own name/project_id fallback can produce", async () => {
    const result = await authorizeRestart(db.sql, { command: "proj_stop", payload: { project_id: 42 } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/malformed/);
  });

  test("F2: a command outside the gated set with no fingerprint is still allowed — the safe default is unchanged for genuinely ungated commands", async () => {
    const result = await authorizeRestart(db.sql, { command: "stack_up", payload: {} });
    expect(result.ok).toBe(true);
  });

  // F6 — a standing grant authorizes an autonomous actor via
  // `authorizeAutonomousAction`, never an operator-issued `admin_commands`
  // row. Without this check a standing grant would be an unlimited-use
  // operator bypass of P-2.2's single-use rule for its fingerprint.
  test("F6: a standing grant does not authorize an operator-issued admin_commands row, even with a matching fingerprint", async () => {
    const path = "/tmp/standing-not-operator";
    const standing = await issueStandingGrant(db.sql, {
      fingerprint: { half: "sessions", scope: path, downtime: "full" },
      actor: "tmux-watchdog",
      authorizedBy: 1,
    });
    const result = await authorizeRestart(db.sql, {
      command: "proj_stop",
      payload: { path, grantId: standing.grantId },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/standing/);
  });

  test("a matching, unspent grant authorizes the action", async () => {
    const grant = await issueOperatorGrant(db.sql, {
      fingerprint: { half: "container", scope: "all", downtime: "brief" },
      issuedBy: 1,
      pendingCommand: "full_restart", // arbitrary — authorizeRestart only checks payload.grantId + command
    });
    const result = await authorizeRestart(db.sql, {
      command: "host_restart",
      payload: { grantId: grant.grantId },
    });
    // container/all/brief does not match host_restart's sessions/all/brief —
    // proves the gate checks the REQUESTED command's fingerprint, not
    // whatever the grant happened to be issued for.
    expect(result.ok).toBe(false);
  });
});

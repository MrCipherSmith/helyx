/**
 * AC5 — the A2 fingerprint gate sits above the restart lease, not in place of
 * it.
 *
 * `scripts/admin-daemon.ts` is a long-running daemon with real side effects
 * at import time (it opens a Postgres connection and starts polling before
 * the first line of test code could run), so — same as
 * `admin-daemon-timeouts.test.ts` — this reads the source rather than
 * importing it. The question is entirely structural: at each of the three
 * commands that call `claimRestart()`, does `authorizeOrRefuse()` (the A2
 * gate) run first, and does `claimRestart()` still exist and still get
 * called at all? `restart-lease.test.ts` already proves `heldMessage` names
 * the holder and the age; this test only has to prove the gate did not
 * remove that call.
 */

import { describe, test, expect } from "bun:test";

const source = await Bun.file(new URL("../../scripts/admin-daemon.ts", import.meta.url)).text();

describe("the A2 gate above claimRestart", () => {
  test("claimRestart is still defined, backed by takeRestartLease/heldMessage — the lease stays (P-2.6)", () => {
    expect(source).toContain("const claimRestart");
    expect(source).toContain("takeRestartLease(String(row.command))");
    expect(source).toContain("heldMessage(lease.held)");
  });

  test("authorizeOrRefuse (the A2 gate) is defined and calls authorizeRestart", () => {
    expect(source).toContain("const authorizeOrRefuse");
    expect(source).toContain("authorizeRestart(sql,");
  });

  test("bounce, host_restart and full_restart each call authorizeOrRefuse before claimRestart", () => {
    const cases = ["bounce", "host_restart", "full_restart"];
    for (const name of cases) {
      const caseStart = source.indexOf(`case "${name}": {`);
      expect([name, caseStart]).not.toEqual([name, -1]);

      // The next case block (or the end of the switch) bounds the search so a
      // later case's calls are never mistaken for this one's.
      const nextCase = source.indexOf('case "', caseStart + 1);
      const body = source.slice(caseStart, nextCase === -1 ? source.length : nextCase);

      const gateAt = body.indexOf("authorizeOrRefuse()");
      const leaseAt = body.indexOf("claimRestart()");
      expect([name, gateAt]).not.toEqual([name, -1]);
      expect([name, leaseAt]).not.toEqual([name, -1]);
      expect([name, gateAt < leaseAt]).toEqual([name, true]);

      // An unapproved action must not take the lease: the gate's refusal
      // branch has to `break` out of the case before claimRestart() runs.
      const gateRefusal = body.slice(gateAt, leaseAt);
      expect([name, gateRefusal]).toEqual([name, expect.stringContaining("break;")]);
    }
  });

  test("no other case in the switch calls claimRestart — the three above are the whole gated family", () => {
    // The call sites read `const claim = claimRestart();` verbatim at all
    // three (and nowhere else) — narrower than counting the bare substring
    // `claimRestart()`, which also appears inside a comment explaining why
    // full_restart's shell-out sets HELYX_RESTART_LEASE_HELD.
    const occurrences = source.split("const claim = claimRestart();").length - 1;
    expect(occurrences).toBe(3);
  });
});

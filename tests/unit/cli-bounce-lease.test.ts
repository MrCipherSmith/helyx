/**
 * AC11 — `bun cli.ts bounce`, run directly on the host, no longer proceeds
 * silently while a Telegram-triggered restart holds the lease.
 *
 * `CLAUDE.md` names this exact gap: "That lease does not cover `bun cli.ts
 * bounce` run directly on the host. The CLI's own `bounce` case … never calls
 * `claimRestart`." `cli.ts` is a script whose top-level `switch` runs
 * immediately on import/execution — the same reason `admin-daemon.ts` is
 * tested by reading its source rather than importing it applies here too.
 */

import { describe, test, expect } from "bun:test";

const source = await Bun.file(new URL("../../cli.ts", import.meta.url)).text();

describe("cli.ts bounce — the lease-aware branch", () => {
  const caseStart = source.indexOf('case "bounce": {');
  const nextCase = source.indexOf('case "', caseStart + 1);
  const body = source.slice(caseStart, nextCase === -1 ? source.length : nextCase);

  test("the case exists", () => {
    expect(caseStart).not.toBe(-1);
  });

  test("it takes the restart lease before touching tmux, and refuses (rather than proceeding) when another restart holds it", () => {
    const leaseAt = body.indexOf("takeRestartLease(");
    const tmuxStopAt = body.indexOf("tmuxStop()");
    expect(leaseAt).not.toBe(-1);
    expect(tmuxStopAt).not.toBe(-1);
    expect(leaseAt).toBeLessThan(tmuxStopAt);

    // A refusal has to be visible, not silent — this is the exact defect
    // being closed: a bare "proceeds silently" against a held lease.
    expect(body).toContain("heldMessage(lease.held)");
  });

  test("it releases the lease it took, and only the one it took", () => {
    // HELYX_RESTART_LEASE_HELD=1 marks a sub-step of an already-leased restart
    // — restart-host.ts and admin-daemon.ts's full_restart both set it when
    // they shell out to this same branch. Releasing unconditionally there
    // would hand the outer restart's lease back to itself mid-flight.
    expect(body).toContain("HELYX_RESTART_LEASE_HELD");
    expect(body).toContain("releaseRestartLease()");
    expect(body).toContain("if (!heldByCaller) releaseRestartLease();");
  });
});

describe("the sub-steps that already hold the lease say so", () => {
  test("restart-host.ts sets HELYX_RESTART_LEASE_HELD=1 on its own `cli.ts bounce` shell-out", async () => {
    const restartHost = await Bun.file(new URL("../../scripts/restart-host.ts", import.meta.url)).text();
    const bounceLine = restartHost.split("\n").find((l) => l.includes("bounce 2>&1"));
    expect(bounceLine).toContain("HELYX_RESTART_LEASE_HELD=1");
  });

  test("admin-daemon.ts's full_restart sets it too", async () => {
    const adminDaemon = await Bun.file(new URL("../../scripts/admin-daemon.ts", import.meta.url)).text();
    const caseStart = adminDaemon.indexOf('case "full_restart": {');
    const nextCase = adminDaemon.indexOf('case "', caseStart + 1);
    const body = adminDaemon.slice(caseStart, nextCase === -1 ? adminDaemon.length : nextCase);
    expect(body).toContain("HELYX_RESTART_LEASE_HELD=1");
  });
});

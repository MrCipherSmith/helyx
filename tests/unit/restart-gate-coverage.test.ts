/**
 * AC15–AC19 — that the gate covers every entrance, and keeps covering them.
 *
 * The first implementation of A2 gated three commands. Not because it was
 * careless: the specification's own mapping table named three, and the plan
 * pointed at the three line numbers where `claimRestart()` is called. The
 * mistake was upstream, in treating "takes the restart lease" as a synonym for
 * "needs approval" — they are different questions (P-2.6), and five commands
 * that can take part of the system down take no lease at all.
 *
 * A control over three of eight entrances is a control over three entrances.
 * AC19 is the test that stops it happening a second time: every `case` label
 * in `scripts/admin-daemon.ts` must be accounted for in exactly one of the
 * three declared sets, so a command added next year cannot slip past the gate
 * by simply not being thought about.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATED_RESTART_COMMANDS,
  EXEMPT_BRING_UP_COMMANDS,
  NOT_TEARDOWN_CAPABLE_COMMANDS,
} from "../../scripts/restart-gate.ts";
import { fingerprintOf, type ActionFingerprint } from "../../utils/action-approval-grant.ts";

const DAEMON_SOURCE = readFileSync(join(import.meta.dir, "../../scripts/admin-daemon.ts"), "utf8");

/** Every `case "<label>":` in the daemon's command switch. */
function daemonCommandLabels(): string[] {
  return [...new Set([...DAEMON_SOURCE.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!))].sort();
}

describe("AC15: every teardown-capable command is gated, with the mapped fingerprint", () => {
  const expected: Array<[string, Record<string, unknown>, ActionFingerprint]> = [
    ["bounce", {}, { half: "sessions", scope: "all", downtime: "brief" }],
    ["host_restart", {}, { half: "sessions", scope: "all", downtime: "brief" }],
    ["full_restart", {}, { half: "both", scope: "all", downtime: "full" }],
    ["docker_restart", { container: "helyx-bot-1" }, { half: "container", scope: "container:helyx-bot-1", downtime: "brief" }],
    ["docker_restart_all", {}, { half: "container", scope: "all", downtime: "brief" }],
    ["tmux_stop", {}, { half: "sessions", scope: "all", downtime: "full" }],
    ["channel_kill", {}, { half: "sessions", scope: "all", downtime: "brief" }],
    ["proj_stop", { path: "/home/altsay/bots/helyx" }, { half: "sessions", scope: "/home/altsay/bots/helyx", downtime: "full" }],
  ];

  test("all eight are declared gated", () => {
    expect([...GATED_RESTART_COMMANDS].sort()).toEqual(expected.map(([c]) => c).sort());
  });

  for (const [command, payload, fingerprint] of expected) {
    test(`${command} → ${fingerprint.half}/${fingerprint.scope}/${fingerprint.downtime}`, () => {
      expect(fingerprintOf({ command, payload })).toEqual(fingerprint);
    });
  }

  test("each gated command is actually reached by the gate in the daemon", () => {
    // The mapping existing is not the same as the call site using it. Each
    // gated `case` must have an `authorizeOrRefuse()` before its work.
    const gateCalls = DAEMON_SOURCE.match(/authorizeOrRefuse\(\)/g) ?? [];
    expect(gateCalls.length).toBe(GATED_RESTART_COMMANDS.size);
  });
});

describe("AC16: a command nothing brings back is `full`, not `brief`", () => {
  // The distinction CLAUDE.md warns about: this family takes things down and
  // nothing returns them. An operator approving `brief` is approving a blip;
  // approving `full` is approving an outage until they act again.
  test("tmux_stop is full", () => {
    expect(fingerprintOf({ command: "tmux_stop" })?.downtime).toBe("full");
  });

  test("proj_stop is full", () => {
    expect(fingerprintOf({ command: "proj_stop", payload: { path: "/x" } })?.downtime).toBe("full");
  });

  test("the ones that do come back on their own stay brief", () => {
    expect(fingerprintOf({ command: "bounce" })?.downtime).toBe("brief");
    expect(fingerprintOf({ command: "channel_kill" })?.downtime).toBe("brief");
  });
});

describe("AC17: one named container is not the container half", () => {
  test("scope carries the container name", () => {
    expect(fingerprintOf({ command: "docker_restart", payload: { container: "helyx-postgres-1" } })).toEqual({
      half: "container",
      scope: "container:helyx-postgres-1",
      downtime: "brief",
    });
  });

  test("a grant for one container does not describe another", () => {
    const postgres = fingerprintOf({ command: "docker_restart", payload: { container: "helyx-postgres-1" } });
    const bot = fingerprintOf({ command: "docker_restart", payload: { container: "helyx-bot-1" } });
    expect(postgres).not.toEqual(bot);
  });

  test("nor does it describe the whole container half", () => {
    const one = fingerprintOf({ command: "docker_restart", payload: { container: "helyx-bot-1" } });
    const all = fingerprintOf({ command: "docker_restart_all" });
    expect(one).not.toEqual(all);
  });

  test("a missing container name yields no fingerprint — structural safety before policy", () => {
    expect(fingerprintOf({ command: "docker_restart", payload: {} })).toBeNull();
  });
});

describe("AC18: bring-up commands stay ungated, by decision", () => {
  test("stack_up, tmux_start and proj_start are the exempt set", () => {
    expect([...EXEMPT_BRING_UP_COMMANDS].sort()).toEqual(["proj_start", "stack_up", "tmux_start"]);
  });

  test("stack_up in particular needs no approval", () => {
    // It is the documented recovery path when the stack is half-down. Gating
    // the command that repairs an outage behind an approval the operator may
    // be unable to give is the wrong shape: an approval exists to stop
    // something being taken away, and this takes nothing away.
    expect(GATED_RESTART_COMMANDS.has("stack_up")).toBe(false);
    expect(fingerprintOf({ command: "stack_up" })).toBeNull();
  });

  test("no exempt command has a fingerprint", () => {
    for (const command of EXEMPT_BRING_UP_COMMANDS) {
      expect([command, fingerprintOf({ command })]).toEqual([command, null]);
    }
  });
});

describe("AC19: no command can be added without a decision about it", () => {
  test("every case label in admin-daemon.ts is in exactly one declared set", () => {
    const unaccounted = daemonCommandLabels().filter(
      (c) =>
        !GATED_RESTART_COMMANDS.has(c) &&
        !EXEMPT_BRING_UP_COMMANDS.has(c) &&
        !NOT_TEARDOWN_CAPABLE_COMMANDS.has(c),
    );

    // If this fails, a command was added to the daemon and nobody decided
    // whether it can take part of the system down. Decide, then add it to
    // GATED_RESTART_COMMANDS (with a fingerprint), EXEMPT_BRING_UP_COMMANDS,
    // or NOT_TEARDOWN_CAPABLE_COMMANDS in scripts/restart-gate.ts.
    expect(unaccounted).toEqual([]);
  });

  test("the three sets are disjoint", () => {
    const all = [...GATED_RESTART_COMMANDS, ...EXEMPT_BRING_UP_COMMANDS, ...NOT_TEARDOWN_CAPABLE_COMMANDS];
    expect(all.length).toBe(new Set(all).size);
  });

  test("the sets describe the daemon and nothing else", () => {
    // A command removed from the daemon but left in a set is the same failure
    // read backwards: the list stops describing reality and stops being
    // trustworthy.
    const labels = new Set(daemonCommandLabels());
    for (const command of [...GATED_RESTART_COMMANDS, ...EXEMPT_BRING_UP_COMMANDS, ...NOT_TEARDOWN_CAPABLE_COMMANDS]) {
      expect([command, labels.has(command)]).toEqual([command, true]);
    }
  });
});

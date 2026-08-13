/**
 * F1 — the producer-side counterpart to AC19.
 *
 * AC19 (`restart-gate-coverage.test.ts`) proves the *consumer* side is
 * exhaustive: every `case` label in `scripts/admin-daemon.ts` is gated or
 * explicitly exempted. Nothing proved the other side. Four call sites
 * (`bot/commands/projects.ts`, `bot/commands/remote-control.ts`,
 * `bot/commands/monitor.ts`, `mcp/dashboard-api.ts`) wrote one of the eight
 * gated commands' literal name straight into an `INSERT INTO admin_commands`
 * `VALUES (...)` clause — the daemon refused every one of them forever with
 * "no approver reachable", and the button that triggered it told the operator
 * it was working. AC19's own reasoning ("a control over three of eight
 * entrances is a control over three entrances") applies symmetrically to
 * producers, and this is the test that would have caught it.
 *
 * ## Why the invariant is "never a literal", not "a literal plus grantId"
 *
 * After this flow's fixes, every gated command reaches `admin_commands`
 * through exactly one place: `bot/commands/restart-grant.ts`'s `grant:go`
 * handler, which inserts `grant.pendingCommand` — a value read back out of
 * the grant row, never a literal in the INSERT statement itself. So the
 * precise, checkable invariant is narrower and stronger than "a grantId is
 * nearby": a literal gated command name should never appear as the `command`
 * argument of an `INSERT INTO admin_commands VALUES (...)` anywhere outside
 * that one file. A weaker "grantId nearby" version of this test was tried
 * first and produced a false positive — an unrelated `if (action ===
 * "docker_restart")` check a few lines after a *different* literal INSERT
 * put the string "docker_restart" inside the scan window with no INSERT of
 * its own. Matching the actual `VALUES (...)` argument, rather than a
 * character window after the statement, avoids that class of mistake instead
 * of just moving the window size around.
 *
 * This is a source scan, not a behavioural one, for the same reason a scan is
 * enough for AC19: the failure mode is a textual property of the call site.
 * It catches a *sixth* producer nobody thought to write a behavioural test
 * for. A behavioural counterpart exists alongside this one, in
 * `restart-confirmation-flow.test.ts`, for the specific handlers this flow
 * already knows about (including the dashboard's ctx-less refusal, which a
 * source scan cannot express as cleanly as "the response was a 403") — and,
 * unlike this scan, it also covers commands reached through a *variable*
 * (`${cmd}`, `${entry.command}`) rather than a literal, which this scan
 * cannot see into.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { GATED_RESTART_COMMANDS } from "../../scripts/restart-gate.ts";

const ROOT = join(import.meta.dir, "../..");
const SCAN_DIRS = ["bot", "mcp", "services", "scripts"];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

// The one legitimate place a gated command's name reaches `admin_commands` —
// as `grant.pendingCommand`, a value read from the grant row, never written
// here as a literal. Excluded so this test states the invariant it actually
// means ("nowhere else"), not "everywhere, including the one place that's
// supposed to be different".
const GRANT_ENQUEUE_FILE = join(ROOT, "bot/commands/restart-grant.ts");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The literal `command` argument of every `INSERT INTO admin_commands
 * (command, payload) VALUES ('<command>', ...)` in `source` — only when it is
 * a quoted literal immediately after `VALUES (`, never a `${...}` expression.
 */
function literalInsertedCommands(source: string): string[] {
  const re = /INSERT INTO admin_commands\s*\(command,\s*payload\)\s*VALUES\s*\(\s*['"]([a-zA-Z_]+)['"]/g;
  return [...source.matchAll(re)].map((m) => m[1]!);
}

describe("F1: no literal gated command name is written directly into an INSERT INTO admin_commands, outside the grant enqueue", () => {
  const files = SCAN_DIRS.flatMap((d) => listSourceFiles(join(ROOT, d))).filter((f) => f !== GRANT_ENQUEUE_FILE);

  test("the scan itself is not vacuous", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("restart-grant.ts really does enqueue via a variable, not a literal — proves the exclusion above is not hiding the one real case", () => {
    const source = readFileSync(GRANT_ENQUEUE_FILE, "utf8");
    expect(literalInsertedCommands(source)).toEqual([]);
    expect(source).toContain("grant.pendingCommand");
  });

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const literalCommands = literalInsertedCommands(source);
    if (literalCommands.length === 0) continue;

    for (const command of new Set(literalCommands)) {
      if (!GATED_RESTART_COMMANDS.has(command)) continue;
      test(`${relative(ROOT, file)} does not enqueue gated command '${command}' as a literal`, () => {
        // Reaching this test at all means the scan found `command` written
        // as a literal INSERT argument in a gated command, outside
        // restart-grant.ts. Fix: route it through beginRestartConfirmation
        // and let restart-grant.ts enqueue it (the pattern every other gated
        // command follows), or, if there is genuinely no ctx to route a
        // confirmation through (the dashboard's case), refuse the request
        // instead of enqueueing a row the daemon will refuse anyway.
        expect(GATED_RESTART_COMMANDS.has(command)).toBe(false);
      });
    }
  }
});

describe("F1: the four previously-broken producers are, at minimum, present in the scan", () => {
  // Not a claim about coverage completeness — a guard against the scan
  // silently stopping to look at these files at all (a renamed directory, a
  // typo in SCAN_DIRS) while still reporting green.
  const files = new Set(SCAN_DIRS.flatMap((d) => listSourceFiles(join(ROOT, d))));
  const mustScan = [
    "bot/commands/projects.ts",
    "bot/commands/remote-control.ts",
    "bot/commands/monitor.ts",
    "mcp/dashboard-api.ts",
  ];
  for (const rel of mustScan) {
    test(`${rel} is in the scanned file set`, () => {
      expect(files.has(join(ROOT, rel))).toBe(true);
    });
  }
});

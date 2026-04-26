import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { SUPPORTED_RUNTIMES_LIST } from "../../runtime/supported-runtimes";

/**
 * Drift check: scripts/run-cli.sh enforces the runtime whitelist at exec
 * time via a shell `case` statement; runtime/supported-runtimes.ts
 * enforces it at DB-insertion / wizard-prompt time via a TS Set. The two
 * MUST stay in sync — drift either way (added in one place but not the
 * other) silently fails: a TS-supported runtime that the shell rejects
 * exits 2 in tmux; a shell-supported runtime missing from the TS Set
 * trips the validation guard at INSERT time.
 *
 * This test parses the `case` block in run-cli.sh and asserts the set of
 * branches equals SUPPORTED_RUNTIMES_LIST.
 *
 * Update procedure: add the runtime to BOTH places, never just one.
 */
describe("runtime: supported types — single source of truth", () => {
  const RUN_CLI_PATH = join(import.meta.dirname, "../../scripts/run-cli.sh");

  function parseRunCliCases(): string[] {
    const text = readFileSync(RUN_CLI_PATH, "utf8");
    // Match the body between `case "$RUNTIME_TYPE" in` and `esac`. Lines
    // that look like `  some-name)` declare a case branch (skip the `*)`
    // wildcard at the end).
    const blockMatch = text.match(/case\s+"\$RUNTIME_TYPE"\s+in([\s\S]*?)esac/);
    if (!blockMatch) throw new Error("could not locate `case` block in run-cli.sh");
    const body = blockMatch[1]!;
    const out: string[] = [];
    for (const line of body.split("\n")) {
      // Match `<word>)` at start of line (allowing leading whitespace).
      // Skip the `*)` default branch.
      const m = line.match(/^\s*([a-z][a-z0-9-]*)\)\s*$/);
      if (m) out.push(m[1]!);
    }
    return out.sort();
  }

  test("run-cli.sh case branches match SUPPORTED_RUNTIMES_LIST exactly", () => {
    const shellTypes = parseRunCliCases();
    const tsTypes = [...SUPPORTED_RUNTIMES_LIST].sort();
    expect(shellTypes).toEqual(tsTypes);
  });

  test("SUPPORTED_RUNTIMES_LIST has no duplicates", () => {
    const seen = new Set(SUPPORTED_RUNTIMES_LIST);
    expect(seen.size).toBe(SUPPORTED_RUNTIMES_LIST.length);
  });
});

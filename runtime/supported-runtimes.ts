/**
 * Single source of truth for runtime types supported by Helyx.
 *
 * This module is consumed by:
 *   - runtime/drivers/tmux-driver.ts — SUPPORTED_RUNTIME_TYPES whitelist
 *   - cli.ts — wizard prompts (`helyx setup`, `helyx setup-agents`)
 *   - tests/unit/supported-runtimes.test.ts — drift check vs. run-cli.sh
 *
 * scripts/run-cli.sh is shell and cannot import this file directly. The
 * companion test parses the run-cli.sh `case` statement and asserts that
 * the case branches match `SUPPORTED_RUNTIMES_LIST` exactly — drift in
 * either direction (added here but not there, or vice versa) breaks CI.
 *
 * Adding a new runtime requires:
 *   1. Add to SUPPORTED_RUNTIMES_LIST below
 *   2. Add a corresponding `case "<name>")` in scripts/run-cli.sh with
 *      the launcher command + needs_claude_confirm flag
 *   3. Optionally add to agent_definitions seed in a migration (see v24
 *      and v29 for examples)
 */

export const SUPPORTED_RUNTIMES_LIST = [
  "claude-code",
  "codex-cli",
  "opencode",
  "deepseek-cli",
  "standalone-llm",
] as const;

export type SupportedRuntimeType = (typeof SUPPORTED_RUNTIMES_LIST)[number];

export const SUPPORTED_RUNTIME_TYPES: ReadonlySet<SupportedRuntimeType> = new Set(SUPPORTED_RUNTIMES_LIST);

export function isSupportedRuntimeType(s: string): s is SupportedRuntimeType {
  return (SUPPORTED_RUNTIME_TYPES as ReadonlySet<string>).has(s);
}

/**
 * Default runtime when none is specified. Matches the shell-side default
 * in run-cli.sh (`${2:-claude-code}`).
 */
export const DEFAULT_RUNTIME_TYPE: SupportedRuntimeType = "claude-code";

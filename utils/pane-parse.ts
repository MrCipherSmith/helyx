/**
 * Turning Claude Code's terminal output into a status block.
 *
 * This existed twice — once in `tmux-monitor.ts` for a captured pane, once in
 * `output-monitor.ts` for a `script`-captured file — and the two copies had
 * already drifted three ways while nominally parsing the same format. The
 * duplicate detector named them; this is the single definition they now share.
 *
 * The format itself belongs to Claude Code, not to this project, so both
 * readers must agree about it exactly. Two files agreeing by coincidence is
 * the arrangement that fails quietly the next time one of them is edited.
 */

import { stripAnsi } from "./terminal.ts";

/**
 * Interface chrome — lines that are the CLI talking about itself.
 *
 * `/^\x1b/` used to sit here in the file-reading copy. It is gone rather than
 * carried over: `parseLine` strips the line before `isChrome` sees it, so a
 * pattern anchored on an escape character could never match.
 */
export const CHROME_PATTERNS: readonly RegExp[] = [
  /^─+$/,
  /^❯/,
  /^\? for shortcuts/,
  /^esc to interrupt/,
  /^Enter to confirm/,
  /ctrl\+[a-z] to/,
  /^\s*$/,
];

/** Header and footer the `script` command wraps a captured session in. */
export const SCRIPT_WRAPPER_PATTERNS: readonly RegExp[] = [
  /^Script started/,
  /^Script done/,
];

export function isChrome(line: string, extra: readonly RegExp[] = []): boolean {
  const trimmed = line.trim();
  return CHROME_PATTERNS.some((p) => p.test(trimmed)) || extra.some((p) => p.test(trimmed));
}

export interface ParseOptions {
  /** Chrome patterns beyond the shared set — the `script` wrapper, for a file. */
  extraChrome?: readonly RegExp[];
}

/**
 * One line of pane output as a status line, or null if it carries nothing.
 *
 * ANSI is stripped on every path. The pane-capture copy did not strip, and
 * every pattern below is anchored with `^`, so a line beginning with an escape
 * sequence silently failed to match — the same defect flow 001 fixed in the
 * supervisor and left standing here. Stripping already-clean text costs
 * nothing, so unifying is free in one direction and a fix in the other.
 */
export function parseLine(line: string, options: ParseOptions = {}): string | null {
  // Tabs are kept. A tab is a C0 control and would otherwise go with the rest,
  // but every pattern below matches on `\s`: `●\tBash(ls)` arriving as
  // `●Bash(ls)` stops matching `^●\s+` and the line is lost.
  //
  // The two originals disagreed here — the pane copy did not strip and parsed
  // it, the file copy stripped and did not — so unifying has to pick one.
  // Keeping the tab reproduces the pane copy exactly, payload included.
  // Converting it to a space, which is what the first attempt at this fix did,
  // would have been a third behaviour matching neither.
  const trimmed = stripAnsi(line, { keepTabs: true }).trim();
  if (!trimmed || isChrome(trimmed, options.extraChrome)) return null;

  // Spinner: · Brewing… (10s · ↓ 386 tokens · thinking)
  const spinnerMatch = trimmed.match(/^[·✶✻]\s+(.+)/);
  if (spinnerMatch) return `⏳ ${spinnerMatch[1]}`;

  // Tool call: ● ToolName(args)
  const toolMatch = trimmed.match(/^●\s+(.+)/);
  if (toolMatch) {
    const call = toolMatch[1]!;
    if (call.includes("reply (MCP)") || call.includes("update_status")) return null;

    const agentMatch = call.match(/^(Explore|Agent)\((.+)\)/);
    if (agentMatch) return `● ${agentMatch[1]}: ${agentMatch[2]!.slice(0, 50)}`;

    const bashMatch = call.match(/^Bash\((.+)\)$/);
    if (bashMatch) return `● $ ${bashMatch[1]!.slice(0, 60)}`;

    const fileMatch = call.match(/^(Read|Edit|Write)\((.+)\)$/);
    if (fileMatch) return `● ${fileMatch[1]}: ${fileMatch[2]!.split("/").pop()}`;

    const mcpMatch = call.match(/^\S+\s*-\s*(\w+)\s*\(MCP\)/);
    if (mcpMatch) return `● MCP: ${mcpMatch[1]}`;

    return `● ${call.slice(0, 60)}`;
  }

  // Sub-operation: ⎿ details
  const subMatch = trimmed.match(/^⎿\s+(.+)/);
  if (subMatch) {
    const sub = subMatch[1]!;

    // Order here is not load-bearing: no branch below can match a line that
    // starts with "Error:", so the two copies checking it first and last
    // produced the same answer. Pinned by a test rather than left to be
    // re-derived by whoever next moves it.
    if (sub.startsWith("Error:")) return `  └ ❌ ${sub.slice(0, 55)}`;

    const subTool = sub.match(/^(\w+)\((.+)\)/);
    if (subTool) return `  └ ${subTool[1]}: ${subTool[2]!.slice(0, 50)}`;

    if (sub.match(/^(Read|Search|Grep|Glob|Write|Edit)\s/)) return `  └ ${sub.slice(0, 55)}`;

    return `  └ ${sub.slice(0, 55)}`;
  }

  if (trimmed.match(/^\+\d+ more tool uses/)) return `  ${trimmed}`;

  if (trimmed.match(/^Running \d+ agents?/)) return `🔄 ${trimmed}`;

  // Agent tree: ├─ Name · N tool uses · Nk tokens
  const agentTreeMatch = trimmed.match(/^[├└│][\s─]+(.+)/);
  if (agentTreeMatch) {
    const content = agentTreeMatch[1]!;
    if (content.match(/^⎿\s+/)) {
      return `  │ ⎿ ${content.replace(/^⎿\s+/, "").slice(0, 55)}`;
    }
    return `  ${trimmed.slice(0, 65)}`;
  }

  if (trimmed.startsWith("Tip:")) return null;

  return null;
}

/** How many status lines a block carries — enough for an agent tree with sub-agents. */
export const MAX_STATUS_LINES = 12;

/**
 * A multi-line status block from raw terminal output, or null if nothing in it
 * says anything.
 *
 * Scanned bottom-up: the newest activity is what the status should show, and
 * the scan stops at the prompt line above it, which is where the previous
 * command ended.
 */
export function parseStatus(output: string, options: ParseOptions = {}): string | null {
  const lines = output.split("\n");
  const parsed: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const result = parseLine(lines[i]!, options);
    if (result) {
      parsed.unshift(result);
      if (parsed.length >= MAX_STATUS_LINES) break;
    }
    if (stripAnsi(lines[i]!).trim().startsWith("❯") && parsed.length > 0) break;
  }

  return parsed.length === 0 ? null : parsed.join("\n");
}

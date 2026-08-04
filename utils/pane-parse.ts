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
    if (agentMatch) return `● ${agentMatch[1]}: ${agentMatch[2]!.slice(0, 75)}`;

    const bashMatch = call.match(/^Bash\((.+)\)$/);
    if (bashMatch) return `● $ ${bashMatch[1]!.slice(0, 90)}`;

    const fileMatch = call.match(/^(Read|Edit|Write)\((.+)\)$/);
    if (fileMatch) return `● ${fileMatch[1]}: ${fileMatch[2]!.split("/").pop()}`;

    const mcpMatch = call.match(/^\S+\s*-\s*(\w+)\s*\(MCP\)/);
    if (mcpMatch) return `● MCP: ${mcpMatch[1]}`;

    return `● ${call.slice(0, 90)}`;
  }

  // Sub-operation: ⎿ details
  const subMatch = trimmed.match(/^⎿\s+(.+)/);
  if (subMatch) {
    const sub = subMatch[1]!;

    // Order here is not load-bearing: no branch below can match a line that
    // starts with "Error:", so the two copies checking it first and last
    // produced the same answer. Pinned by a test rather than left to be
    // re-derived by whoever next moves it.
    if (sub.startsWith("Error:")) return `  └ ❌ ${sub.slice(0, 83)}`;

    const subTool = sub.match(/^(\w+)\((.+)\)/);
    if (subTool) return `  └ ${subTool[1]}: ${subTool[2]!.slice(0, 75)}`;

    if (sub.match(/^(Read|Search|Grep|Glob|Write|Edit)\s/)) return `  └ ${sub.slice(0, 83)}`;

    return `  └ ${sub.slice(0, 83)}`;
  }

  if (trimmed.match(/^\+\d+ more tool uses/)) return `  ${trimmed}`;

  if (trimmed.match(/^Running \d+ agents?/)) return `🔄 ${trimmed}`;

  // Agent tree: ├─ Name · N tool uses · Nk tokens
  const agentTreeMatch = trimmed.match(/^[├└│][\s─]+(.+)/);
  if (agentTreeMatch) {
    const content = agentTreeMatch[1]!;
    if (content.match(/^⎿\s+/)) {
      return `  │ ⎿ ${content.replace(/^⎿\s+/, "").slice(0, 83)}`;
    }
    return `  ${trimmed.slice(0, 98)}`;
  }

  if (trimmed.startsWith("Tip:")) return null;

  return null;
}

/** How many status lines a block carries — enough for an agent tree with sub-agents. */
export const MAX_STATUS_LINES = 18;

/**
 * A multi-line status block from raw terminal output, or null if nothing in it
 * says anything.
 *
 * Scanned bottom-up: the newest activity is what the status should show, and
 * the scan stops at the prompt line above it, which is where the previous
 * command ended.
 */
/**
 * The footer Claude Code draws under an interactive menu.
 *
 * The signal, and the only one used. A menu is a run of numbered options, and
 * numbered options are also just ordinary output — a shell printing a list, a
 * test runner counting cases. Keying on the footer means an ordinary list is
 * never mistaken for a prompt, at the cost of leaving a menu in place if Claude
 * Code ever stops drawing it.
 */
export const MENU_FOOTER_RE = /Enter to select|Tab\/Arrow keys to navigate/i;

/** A menu option, highlighted or not. */
const MENU_OPTION_RE = /^\s*[❯>]?\s*\d+[.)]\s+\S/;

/**
 * Drop an interactive menu from captured output.
 *
 * The operator already has the question as Telegram buttons. Mirroring the
 * terminal's own copy of it into the status put "3. Досылать + пометка" and
 * "Enter to select · Esc to cancel" under the buttons that asked the same
 * thing — unpressable, and read as garbage.
 *
 * Only the option run directly above the footer goes: the work above the menu
 * is what the operator is watching, and the menu is what interrupted it.
 */
export function stripInteractiveMenu(lines: readonly string[]): string[] {
  const footer = lines.findIndex((l) => MENU_FOOTER_RE.test(stripAnsi(l)));
  if (footer === -1) return [...lines];

  let start = footer;
  for (let i = footer - 1; i >= 0; i--) {
    const line = stripAnsi(lines[i]!);
    if (MENU_OPTION_RE.test(line) || line.trim() === "") start = i;
    else break;
  }
  return [...lines.slice(0, start), ...lines.slice(footer + 1)];
}

/** Spinner frames and box-drawing — a line of these carries nothing. */
export const PANE_NOISE_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏○◐◑◒◓●▸▹►▻◆◇■□▪▫─│╭╮╰╯┌┐└┘├┤┬┴┼\s]*$/;

/** How many lines of raw pane the status carries. */
export const PANE_SNAPSHOT_LINES = 6;

/**
 * The lines of a captured pane worth storing as the live snapshot.
 *
 * This is what reaches the operator's status message, and it used to be the
 * last six lines of whatever the terminal drew — including an open menu. The
 * operator had the same question in front of them as Telegram buttons, so the
 * status showed "3. Досылать + пометка" and "Enter to select · Esc to cancel"
 * underneath the buttons that asked it: unpressable, and read as garbage.
 */
export function meaningfulPaneLines(lines: readonly string[]): string[] {
  return stripInteractiveMenu(lines)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !PANE_NOISE_RE.test(l))
    .slice(-PANE_SNAPSHOT_LINES);
}

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

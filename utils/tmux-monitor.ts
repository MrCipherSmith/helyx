/**
 * Monitors tmux pane output from Claude Code CLI sessions.
 * Parses tool calls, thinking status, and progress from terminal output.
 * Forwards parsed status to Telegram via callback.
 */

import { parseStatus } from "./pane-parse.ts";

const POLL_INTERVAL_MS = 15_000;

export interface TmuxMonitorHandle {
  stop: () => void;
}

type StatusCallback = (status: string) => void;

/** Resolve actual tmux target for a project name.
 *  Tries:
 *  1. Exact session: <name>
 *  2. Window in "bots" session: bots:<name> (prefix match — tmux accepts partial window names)
 *  Returns the resolved target string or null if not found.
 */
async function resolveTmuxTarget(projectName: string): Promise<string | null> {
  // 1. Try exact session name
  try {
    const proc = Bun.spawn(["tmux", "has-session", "-t", projectName], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) === 0) return projectName;
  } catch {}

  // 2. Try as window in "bots" session (helyx up uses bots:<window>)
  const botsTarget = `bots:${projectName}`;
  try {
    const proc = Bun.spawn(["tmux", "has-session", "-t", botsTarget], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) === 0) return botsTarget;
  } catch {}

  // 3. List all windows in "bots" and find one that starts with projectName
  try {
    const proc = Bun.spawn(
      ["tmux", "list-windows", "-t", "bots", "-F", "#W"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const window = out.split("\n").map((l) => l.trim()).find((w) => w && w.startsWith(projectName));
    if (window) return `bots:${window}`;
  } catch {}

  return null;
}

/** Capture current visible screen from tmux pane (no scrollback).
 *  Current activity (spinner, tool calls) is always at the bottom of the
 *  visible screen — scrollback only adds stale historical content that
 *  causes ghost detections and inflates the status with old tool calls.
 */
async function captureTmux(target: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["tmux", "capture-pane", "-t", target, "-p"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  } catch {
    return "";
  }
}


/** Strip elapsed time/token counters from spinner lines for comparison.
 *  Prevents re-sending status every 2s just because the timer incremented.
 *  Example: "⏳ Brewing… (10s · ↓ 386 tokens · thinking)" →
 *           "⏳ Brewing… ( · ↓  tokens · thinking)"
 */
export function normalizeForComparison(s: string): string {
  return s
    .replace(/\d+m\s*\d+s/g, "") // "1m 23s"
    .replace(/\d+s/g, "")         // "10s"
    .replace(/↓\s*\d+\s*tokens/g, "↓ tokens") // "↓ 386 tokens"
    .replace(/↑\s*\d+\s*tokens/g, "↑ tokens") // "↑ 123 tokens"
    .replace(/\(\s*[·\s]*\)/g, "")             // empty parens "(  · )"
    .trim();
}

/** Start monitoring a tmux session, calling onStatus with updates */
export async function startTmuxMonitor(
  projectName: string,
  onStatus: StatusCallback,
): Promise<TmuxMonitorHandle | null> {
  const target = await resolveTmuxTarget(projectName);
  if (!target) return null;

  let running = true;
  let lastStatus = "";

  const poll = async () => {
    while (running) {
      try {
        const output = await captureTmux(target);
        const status = parseStatus(output);

        if (status && normalizeForComparison(status) !== normalizeForComparison(lastStatus)) {
          lastStatus = status;
          onStatus(status);
        }
      } catch {}

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  poll().catch((err) => console.error("[tmux-monitor] fatal error:", err));

  return {
    stop: () => { running = false; },
  };
}

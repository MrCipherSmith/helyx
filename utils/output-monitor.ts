/**
 * File-based output monitor for Claude CLI sessions.
 * Alternative to tmux-monitor — reads Claude's terminal output
 * captured to a file via `script` command.
 *
 * Uses the same interface as tmux-monitor for drop-in replacement.
 */

import { existsSync } from "fs";
import { parseStatus, SCRIPT_WRAPPER_PATTERNS } from "./pane-parse.ts";
import { normalizeForComparison } from "./tmux-monitor.ts";

const POLL_INTERVAL_MS = 2000;
const TAIL_LINES = 40;

export interface OutputMonitorHandle {
  stop: () => void;
  /** Never present here — see `TmuxMonitorHandle.agents`, same reason. */
  agents?: () => string[];
}

type StatusCallback = (status: string) => void;

// Re-use tmux-monitor's parsing logic for terminal output

/** Read last N lines from a file */
async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Start monitoring a captured output file.
 * The file should be written by `script` command wrapping the Claude CLI process.
 */
export async function startOutputMonitor(
  outputFile: string,
  onStatus: StatusCallback,
): Promise<OutputMonitorHandle | null> {
  if (!existsSync(outputFile)) return null;

  let running = true;
  let lastStatus = "";

  const poll = async () => {
    while (running) {
      try {
        const output = await tailFile(outputFile, TAIL_LINES);
        const status = parseStatus(output, { extraChrome: SCRIPT_WRAPPER_PATTERNS });

        if (status && normalizeForComparison(status) !== normalizeForComparison(lastStatus)) {
          lastStatus = status;
          onStatus(status);
        }
      } catch {}

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  poll().catch((err) => console.error("[output-monitor] fatal error:", err));

  return {
    stop: () => { running = false; },
  };
}

/** Get the output file path for a project */
export function getOutputFilePath(projectName: string): string {
  return `/tmp/claude-output-${projectName}.log`;
}

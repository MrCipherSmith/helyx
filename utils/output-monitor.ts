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
/** How much of the file to read the first time a path is seen, or after it shrinks/is replaced. */
const SEED_TAIL_BYTES = 64 * 1024;
/** Upper bound on the carried buffer per file, so it can't grow with the file forever. */
const MAX_BUFFER_CHARS = 128 * 1024;

export interface OutputMonitorHandle {
  stop: () => void;
  /** Never present here — see `TmuxMonitorHandle.agents`, same reason. */
  agents?: () => string[];
}

type StatusCallback = (status: string) => void;

// Re-use tmux-monitor's parsing logic for terminal output

/**
 * Per-file tail-read state, so a poll reads only the bytes appended since the
 * previous poll instead of the whole file every time (F-002). Keyed by output
 * file path; cleared when the monitor watching that path stops.
 */
interface TailState {
  offset: number;
  /** Trailing text carried across polls, bounded by MAX_BUFFER_CHARS. */
  buffer: string;
}

const tailState = new Map<string, TailState>();

/** Read the last SEED_TAIL_BYTES of a file — used to seed/reseed a tail without reading the whole thing. */
async function seedTail(file: ReturnType<typeof Bun.file>, size: number): Promise<TailState> {
  const start = Math.max(0, size - SEED_TAIL_BYTES);
  const text = await file.slice(start, size).text();
  return { offset: size, buffer: text };
}

/**
 * Read the last N lines of a file, reading only what changed since the last
 * call for that path rather than the whole file.
 *
 * Mirrors `TranscriptTail` (utils/transcript-locate.ts) — track a byte
 * offset, read only the bytes appended since it, and treat a file that
 * shrank as a different file needing a fresh read from its (new) tail —
 * instead of `Bun.file(filePath).text()`-ing the entire captured-output file
 * on every 2-second poll, a cost that scaled with everything the session had
 * ever printed rather than with the ~40 lines actually needed. That exact bug
 * class was already fixed once for the primary transcript-tailing path; this
 * applies the same approach to this sibling monitor.
 */
export async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    let state = tailState.get(filePath);

    if (!state || size < state.offset) {
      // First read for this path, or the file was truncated/replaced —
      // either way the stored offset no longer names a valid starting
      // point, so reseed from this file's current tail.
      state = await seedTail(file, size);
      tailState.set(filePath, state);
    } else if (size > state.offset) {
      const appended = await file.slice(state.offset, size).text();
      state.buffer = (state.buffer + appended).slice(-MAX_BUFFER_CHARS);
      state.offset = size;
    }
    // size === state.offset: nothing new since the last poll — reuse the buffer as-is.

    const allLines = state.buffer.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** The byte offset tailFile has read up to for a path, or undefined if never polled. Exported for tests only. */
export function _tailOffsetForTest(filePath: string): number | undefined {
  return tailState.get(filePath)?.offset;
}

/** Forget all tracked tail state. Exported for tests only, so cases don't leak state via shared temp paths. */
export function _resetTailStateForTest(): void {
  tailState.clear();
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
    stop: () => {
      running = false;
      // Otherwise tailState grows by one entry for every distinct output
      // file this process ever monitors, for the process's lifetime.
      tailState.delete(outputFile);
    },
  };
}

/** Get the output file path for a project */
export function getOutputFilePath(projectName: string): string {
  return `/tmp/claude-output-${projectName}.log`;
}

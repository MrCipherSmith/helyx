/**
 * The status monitor that reads the session instead of watching its terminal.
 *
 * Same contract as `tmux-monitor.ts` and `output-monitor.ts` — a `{ stop() }`
 * handle, a callback that receives a status block, null when there is nothing to
 * attach to — so `StatusManager` gains it by trying it first and keeps both
 * others as the fallback.
 *
 * What differs is everything upstream of that contract. The terminal monitors
 * photograph a screen every fifteen seconds and keep the lines a whitelist
 * recognises; this reads an append-only record of what the session actually did,
 * so a tool call between two polls is still there when the poll arrives, and a
 * paragraph of reasoning is content rather than noise to be filtered out.
 *
 * The polling half and the deciding half are separate: `TranscriptSession` is
 * the state machine and can be stepped one poll at a time, `startTranscriptMonitor`
 * is the timer around it. The version of this that put both in one closure could
 * only be tested by having a real session write a real file.
 */

import { resolveTranscript, TranscriptTail, parseEntry, claudeConfigRoot } from "./transcript-locate.ts";
import { renderEntry, outputTokens, renderTokenLine } from "./transcript-events.ts";

/** A file tail, not a subprocess — cheap enough to ask often. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * Lines kept.
 *
 * Bounded rather than budgeted here: `status-render.ts` owns the character
 * budget and keeps the newest lines that fit. This bound exists so a subagent
 * fan-out cannot grow the buffer without limit between two renders.
 */
export const BUFFER_LINES = 60;

/** Empty polls before asking whether the session moved to a new transcript. */
export const RERESOLVE_AFTER_EMPTY_POLLS = 15;

export interface TranscriptMonitorHandle {
  stop: () => void;
}

type StatusCallback = (status: string) => void;

/** Newest-last, oldest dropped. */
export class LineBuffer {
  private lines: string[] = [];

  constructor(private readonly capacity: number = BUFFER_LINES) {}

  push(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.lines.push(...lines);
    if (this.lines.length > this.capacity) {
      this.lines = this.lines.slice(-this.capacity);
    }
  }

  get size(): number {
    return this.lines.length;
  }

  render(): string {
    return this.lines.join("\n");
  }
}

export interface TranscriptSessionOptions {
  /** Where `~/.claude` is. Defaults to the mount point or the real home. */
  root?: string;
  bufferLines?: number;
  /**
   * Start reading from the beginning of the resolved file.
   *
   * False in production — see `TranscriptTail.atEnd`. True in tests, where the
   * fixture is written before the session attaches and the point is to read it.
   */
  fromStart?: boolean;
}

/**
 * One session's reader: resolve, tail, render, decide whether to say anything.
 */
export class TranscriptSession {
  private tail: TranscriptTail | null = null;
  private buffer: LineBuffer;
  private tokenTotal = 0;
  private emptyPolls = 0;
  private lastEmitted: string | null = null;

  constructor(
    private readonly projectPath: string,
    private readonly options: TranscriptSessionOptions = {},
  ) {
    this.buffer = new LineBuffer(options.bufferLines ?? BUFFER_LINES);
  }

  /** The transcript currently being read, or null before the first resolve. */
  get path(): string | null {
    return this.tail?.path ?? null;
  }

  /** Attach to the newest transcript for this project. False when there is none. */
  async attach(): Promise<boolean> {
    const root = this.options.root ?? claudeConfigRoot();
    const path = await resolveTranscript(this.projectPath, root);
    if (!path) return false;
    this.tail = this.options.fromStart
      ? TranscriptTail.at(path, 0)
      : await TranscriptTail.atEnd(path);
    return true;
  }

  /**
   * One step. Returns the status block when it has changed, null otherwise.
   *
   * Null on an unchanged block rather than the block itself: `StatusManager`
   * would dedup it by signature anyway, and an edit that is going to be
   * discarded is still a Telegram request that counts against the rate limit.
   */
  async poll(): Promise<string | null> {
    if (!this.tail && !(await this.attach())) return null;

    const lines = await this.tail!.read();

    if (lines.length === 0) {
      this.emptyPolls++;
      if (this.emptyPolls >= RERESOLVE_AFTER_EMPTY_POLLS) {
        this.emptyPolls = 0;
        await this.reresolve();
      }
      return null;
    }
    this.emptyPolls = 0;

    const rendered: string[] = [];
    for (const line of lines) {
      const entry = parseEntry(line);
      const tokens = outputTokens(entry);
      if (tokens !== null) this.tokenTotal += tokens;
      rendered.push(...renderEntry(entry));
    }
    this.buffer.push(rendered);

    if (this.buffer.size === 0) return null;

    // The token line leads, as the spinner line does in a scraped block: it is
    // the header material, and `scrapeTokenInfo` reads it out of whatever it is
    // given.
    const block = this.tokenTotal > 0
      ? `${renderTokenLine(this.tokenTotal)}\n${this.buffer.render()}`
      : this.buffer.render();

    if (block === this.lastEmitted) return null;
    this.lastEmitted = block;
    return block;
  }

  /**
   * Follow the session to a new transcript, if it started one.
   *
   * A new file is read from its beginning: it is a new turn's worth of bytes,
   * not a session's history, and skipping to its end would hide the very lines
   * the operator is waiting for.
   */
  private async reresolve(): Promise<void> {
    const root = this.options.root ?? claudeConfigRoot();
    const path = await resolveTranscript(this.projectPath, root);
    if (!path || path === this.tail?.path) return;
    this.tail = TranscriptTail.at(path, 0);
  }
}

/**
 * Start following a project's transcript.
 *
 * Null when nothing resolves — no session, nothing mounted at the config root, a
 * CLI started some other way. The caller falls back to the terminal monitors,
 * which is exactly what it did before this existed.
 */
export async function startTranscriptMonitor(
  projectPath: string,
  onStatus: StatusCallback,
  options: TranscriptSessionOptions & { intervalMs?: number } = {},
): Promise<TranscriptMonitorHandle | null> {
  const session = new TranscriptSession(projectPath, options);
  if (!(await session.attach())) return null;

  let running = true;
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;

  const loop = async () => {
    while (running) {
      try {
        const block = await session.poll();
        if (block) onStatus(block);
      } catch {
        /* a transcript that vanished or a read that raced — the next poll retries */
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  };

  loop().catch((err) => console.error("[transcript-monitor] fatal error:", err));

  return { stop: () => { running = false; } };
}

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
import { compactBoundaries, apiErrors, type CompactBoundary, type ApiErrorEvent } from "./context-usage.ts";
import { findSubagents, selectAgents, markLines, MAX_TRACKED_AGENTS, type FileAccess, type SubagentFile } from "./subagent-transcripts.ts";
import { readdir, stat, readFile } from "fs/promises";

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

/** How many finished agents' read positions are remembered. */
export const REMEMBERED_OFFSETS = 64;

/** Empty polls before asking whether the session moved to a new transcript. */
export const RERESOLVE_AFTER_EMPTY_POLLS = 15;

/**
 * How old the newest transcript may be and still be worth attaching to.
 *
 * Raised in review, and the sharper half of the finding: attaching always
 * succeeds, because a file that has not been written to since last week still
 * opens and still reports an end. So a project whose last Claude Code session
 * was days ago would take the transcript path, sit on a dead file, and never
 * fall through to the terminal monitors — a status that is empty rather than
 * wrong, which is harder to notice.
 *
 * Twelve hours: long enough to cover a session that has been idle while its
 * operator slept, short enough that an abandoned project falls back.
 */
export const TRANSCRIPT_STALE_MS = 12 * 60 * 60 * 1_000;

export interface TranscriptMonitorHandle {
  stop: () => void;
  /**
   * Labels of the subagents being followed right now.
   *
   * A getter rather than a widening of the status callback, which carries a
   * rendered block of text: a count of running agents is not a block of text,
   * and every other monitor would have had to learn to send one.
   *
   * Optional on the interface because the two terminal monitors share it and
   * cannot answer — they photograph a screen and have no idea what a subagent
   * is.
   */
  agents?: () => string[];
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

  clear(): void {
    this.lines = [];
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
  /** How stale a transcript may be and still be attached to. */
  maxAgeMs?: number;
  bufferLines?: number;
  /**
   * Start reading from the beginning of the resolved file.
   *
   * False in production — see `TranscriptTail.atEnd`. True in tests, where the
   * fixture is written before the session attaches and the point is to read it.
   */
  fromStart?: boolean;
  /**
   * How the subagent directory is read. Injected so a test can state the
   * layout as a fake tree rather than depend on the operator's `~/.claude`.
   */
  files?: FileAccess;
  /** How many subagents may be followed at once. */
  maxAgents?: number;
  /**
   * Ignore subagent files older than this.
   *
   * Defaults to when this session was constructed: a fan-out from a previous
   * session still opens and still reports an end, and reading one would
   * attribute yesterday's work to this turn.
   */
  subagentsSince?: number;
  /**
   * Claude Code has just folded its context, and said what it dropped.
   *
   * A callback rather than work done here, and that division is the point. This
   * module reads files; what a fold is *worth* — a span pulled out by uuid, an
   * embedding call, a status message that stops looking like silence — belongs
   * to `channel/status.ts`, which already receives everything else this poll
   * finds. A reader that also wrote to Postgres would be two modules sharing a
   * name.
   *
   * Called once per boundary in the lines a single poll read, in file order, and
   * only for the session's own transcript: a subagent's fold is its own context
   * and not what the operator's session forgot.
   */
  onCompactBoundary?: (boundary: CompactBoundary, transcriptPath: string) => void;
  /**
   * A turn failed on the API rather than on the work.
   *
   * The same division as `onCompactBoundary` above, and it is the whole reason
   * this is a second callback rather than a second reader: the error is one more
   * kind of line the poll is already reading, and what it is *worth* — a marker
   * in `sessions.metadata`, an alert that names the limit instead of calling the
   * session hung — belongs to `channel/status.ts`.
   *
   * Called once per error in the lines a single poll read, in file order, and
   * only for the session's own transcript. A subagent that hit a limit failed
   * inside the parent's turn; the parent will report it as its own.
   */
  onApiError?: (error: ApiErrorEvent, transcriptPath: string) => void;
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
  /**
   * One tail per subagent being followed.
   *
   * A subagent writes to its own file and the parent's transcript receives
   * nothing until the tool returns, so without these the status is motionless
   * for exactly as long as the fan-out runs — which reads as hung.
   */
  private readonly agents = new Map<string, { file: SubagentFile; tail: TranscriptTail }>();
  /**
   * Where each agent's file had been read to when its tail was dropped.
   *
   * An agent whose file disappears and comes back — a restart, or a race —
   * would otherwise be re-read from the beginning, so its lines would arrive
   * twice and its tokens be counted twice. `TranscriptTail` already refuses an
   * offset that is not a record boundary, so a genuinely new file at the same
   * path still starts from zero.
   */
  private readonly agentOffsets = new Map<string, number>();
  private readonly startedAt: number;

  constructor(
    private readonly projectPath: string,
    private readonly options: TranscriptSessionOptions = {},
  ) {
    this.buffer = new LineBuffer(options.bufferLines ?? BUFFER_LINES);
    this.startedAt = options.subagentsSince ?? Date.now();
  }

  /** Real file access unless a test supplied its own tree. */
  private get files(): FileAccess {
    return this.options.files ?? {
      readdir: (dir) => readdir(dir),
      stat: async (path) => ({ mtimeMs: (await stat(path)).mtimeMs }),
      readFile: (path) => readFile(path, "utf-8"),
    };
  }

  /**
   * Read whatever the subagents have written since the last poll.
   *
   * Newest agents win the cap, and one that stops being listed — its file gone
   * or aged out — is dropped rather than tailed for ever.
   */
  private async pollAgents(): Promise<string[]> {
    try {
      return await this.readAgents();
    } catch {
      // The parent's lines have already been read and its offset advanced by
      // the time this runs, so anything thrown here would lose them. Nothing in
      // the body is expected to throw — every read is guarded — and this is the
      // belt for the case that is not thought of. Raised in review.
      return [];
    }
  }

  private async readAgents(): Promise<string[]> {
    const parent = this.tail?.path;
    if (!parent) return [];

    // Uncapped here: the cap is applied by `selectAgents`, which has to see
    // the ones already being followed before it decides what to drop.
    const all = await findSubagents(parent, {
      since: this.startedAt,
      files: this.files,
    }).catch(() => [] as SubagentFile[]);
    const found = selectAgents(all, new Set(this.agents.keys()), this.options.maxAgents ?? MAX_TRACKED_AGENTS);

    const live = new Set(found.map((f) => f.agentId));
    for (const [id, tracked] of [...this.agents.entries()]) {
      if (live.has(id)) continue;
      this.agentOffsets.set(id, tracked.tail.position);
      // Bounded: a session that spawned hundreds of agents would otherwise
      // remember every one of them for as long as it lived.
      if (this.agentOffsets.size > REMEMBERED_OFFSETS) {
        const oldest = this.agentOffsets.keys().next().value;
        if (oldest !== undefined) this.agentOffsets.delete(oldest);
      }
      this.agents.delete(id);
    }

    const out: string[] = [];
    for (const file of found) {
      let tracked = this.agents.get(file.agentId);
      if (!tracked) {
        // From the beginning: a fan-out that started between two polls has
        // already written the lines the operator is waiting for.
        tracked = { file, tail: TranscriptTail.at(file.path, this.agentOffsets.get(file.agentId) ?? 0) };
        this.agents.set(file.agentId, tracked);
      }
      const lines = await tracked.tail.read().catch(() => [] as string[]);
      const rendered: string[] = [];
      for (const line of lines) {
        const entry = parseEntry(line);
        // Counted into the same total as the parent's, deliberately: a fan-out's
        // output is what this turn cost, and a header that showed only the
        // parent's would report a fraction of it while three agents ran. Raised
        // in review as a decision worth stating rather than leaving implied.
        const tokens = outputTokens(entry);
        if (tokens !== null) this.tokenTotal += tokens;
        rendered.push(...renderEntry(entry));
      }
      out.push(...markLines(tracked.file.label, rendered));
    }
    return out;
  }

  /**
   * Tell the caller about any fold in the lines just read.
   *
   * Nothing is thrown out of here. The tail's read position has already moved
   * past these lines by the time this runs, so an exception would lose them —
   * the same reasoning `pollAgents` carries, and the same belt: a callback that
   * writes to Postgres has more ways to fail than this module has to recover.
   */
  private announceBoundaries(lines: readonly string[]): void {
    const notify = this.options.onCompactBoundary;
    const path = this.tail?.path;
    if (!notify || !path || lines.length === 0) return;
    try {
      for (const boundary of compactBoundaries(lines)) notify(boundary, path);
    } catch {
      /* the caller's problem to log; losing this poll's lines is not the price */
    }
  }

  /**
   * Tell the caller about any API error in the lines just read.
   *
   * Separate from `announceBoundaries` rather than folded into one walk: the two
   * callbacks are independent and a throw out of either must not cost the other
   * its lines. Same belt as above and for the same measured reason — the tail's
   * read position has already moved past these lines by the time this runs.
   */
  private announceApiErrors(lines: readonly string[]): void {
    const notify = this.options.onApiError;
    const path = this.tail?.path;
    if (!notify || !path || lines.length === 0) return;
    try {
      for (const error of apiErrors(lines)) notify(error, path);
    } catch {
      /* the caller's problem to log; losing this poll's lines is not the price */
    }
  }

  /** The transcript currently being read, or null before the first resolve. */
  get path(): string | null {
    return this.tail?.path ?? null;
  }

  /**
   * What to call the subagents being followed right now.
   *
   * Read from the same map `readAgents` maintains, so an agent that finished is
   * gone from here for the same reason its lines stopped arriving — there is no
   * second list to fall out of step with the first.
   */
  get agentLabels(): string[] {
    return [...this.agents.values()].map((tracked) => tracked.file.label);
  }

  /** Attach to the newest transcript for this project. False when there is none. */
  async attach(): Promise<boolean> {
    const root = this.options.root ?? claudeConfigRoot();
    const path = await resolveTranscript(this.projectPath, root, {
      maxAgeMs: this.options.maxAgeMs ?? TRANSCRIPT_STALE_MS,
    });
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
    this.announceBoundaries(lines);
    this.announceApiErrors(lines);
    // Asked every poll, including the ones where the parent said nothing —
    // which is precisely what a fan-out looks like from here.
    const fromAgents = await this.pollAgents();

    if (lines.length === 0 && fromAgents.length === 0) {
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
    // Subagents first, the parent last: the buffer drops its oldest, and a
    // chatty fan-out would otherwise push the session's own work off the block
    // it is supposed to be about. Raised in review, and the reason the order
    // here is not chronological.
    this.buffer.push(fromAgents);
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
   *
   * The counters go with it. Carrying them over meant the new session's header
   * opened with the old one's token total, and its first status still showed
   * the previous session's last few lines — an operator watching a fresh
   * session read someone else's work as their own. Found in review rather than
   * by anyone watching a handover, which is the only way this would have
   * surfaced otherwise.
   */
  private async reresolve(): Promise<void> {
    const root = this.options.root ?? claudeConfigRoot();
    // The same freshness bound as `attach`. Raised in review: without it, a
    // session whose transcript disappears could be re-attached to an arbitrarily
    // old one and replay it from the beginning.
    const path = await resolveTranscript(this.projectPath, root, {
      maxAgeMs: this.options.maxAgeMs ?? TRANSCRIPT_STALE_MS,
    });
    if (!path || path === this.tail?.path) return;
    this.tail = TranscriptTail.at(path, 0);
    // The old session's subagents belong to the old session — and so do their
    // offsets: a new session that happened to reuse an agent id would otherwise
    // resume into a file it has never read. Raised in review.
    this.agents.clear();
    this.agentOffsets.clear();
    this.buffer.clear();
    this.tokenTotal = 0;
    this.lastEmitted = null;
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

  return {
    stop: () => { running = false; },
    agents: () => session.agentLabels,
  };
}

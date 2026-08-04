/**
 * Finding a session's own transcript, and reading it forward.
 *
 * Claude Code appends every event of an interactive session to
 * `<config>/projects/<slug>/<session-id>.jsonl`. That file is the complete,
 * ordered, timestamped record of what the session did — which is exactly what
 * the status message was trying and failing to reconstruct by photographing the
 * terminal every fifteen seconds.
 *
 * ## Why the slug is not computed
 *
 * `<slug>` is the working directory with its separators rewritten, and the rule
 * is Claude Code's, undocumented, and already irregular in practice:
 *
 *   /home/altsay/bots/helyx          → -home-altsay-bots-helyx
 *   /tmp/claude-1000/-home-…-proxy   → -tmp-claude-1000--home-…-proxy
 *
 * Reproducing that by substitution is a guess, and a guess that fails silently:
 * the wrong answer is an empty status, not an error. Every entry in the file
 * carries its own `cwd`, so the file is asked directly which directory it
 * belongs to. That answer cannot drift, and it stays right if the encoding
 * changes.
 *
 * ## Why reading starts at the end
 *
 * These files reach tens of megabytes over a session's life. The operator is
 * watching what is happening now; replaying the whole history into a Telegram
 * message would be both useless and unsendable.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat, open } from "node:fs/promises";

/** One line of the transcript, parsed. Fields beyond these are ignored, not rejected. */
export interface TranscriptEntry {
  type?: string;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

/**
 * Where `~/.claude` is, from this process's point of view.
 *
 * `HOST_CLAUDE_CONFIG` is set in `docker-compose.yml` to the mount point of the
 * host's config directory, because the bot runs in a container and the sessions
 * do not. Outside the container the env var is absent and the real home applies.
 *
 * `utils/tools-reader.ts:53` answers the same question differently — it falls
 * back to the literal `/host-claude-config`, which only exists inside the
 * container. Said out loud rather than quietly unified: that module is only ever
 * run in the container, this one is also run by tests and by a host process, and
 * changing its fallback would change what it finds on a developer's machine.
 * Two answers that disagree on purpose, not two answers nobody compared.
 */
export function claudeConfigRoot(env: Record<string, string | undefined> = process.env): string {
  return env.HOST_CLAUDE_CONFIG || join(homedir(), ".claude");
}

/**
 * How many transcripts are opened before giving up on a project path.
 *
 * Candidates are ordered newest-first and an active session's file is the one
 * being written to, so the match is normally the first read. The cap is for the
 * miss: a host with years of dead sessions should not pay a directory's worth of
 * reads every time a monitor starts and finds nothing.
 */
export const MAX_CANDIDATES = 40;

interface Candidate {
  path: string;
  mtimeMs: number;
}

/** Every `.jsonl` file one level below `<root>/projects`, newest first. */
async function listTranscripts(root: string): Promise<Candidate[]> {
  const projects = join(root, "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return [];
  }

  const out: Candidate[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(join(projects, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(projects, dir, file);
      try {
        const info = await stat(path);
        if (info.isFile()) out.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        /* vanished between readdir and stat — a session that just ended */
      }
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The first bytes of a file, enough to hold its first line. */
async function readHead(path: string, bytes = 64 * 1024): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The `cwd` a transcript declares, or null.
 *
 * The first *parseable* line, not the first line: a file caught mid-write can
 * begin with a fragment, and one unlucky read should not disqualify a file that
 * is otherwise the right one.
 */
export function declaredCwd(head: string): string | null {
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as TranscriptEntry;
      if (typeof entry.cwd === "string" && entry.cwd) return entry.cwd;
    } catch {
      /* fragment or not JSON — keep looking */
    }
  }
  return null;
}

/** Trailing separators removed, so `/a/b` and `/a/b/` are the same directory. */
function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The newest transcript belonging to `projectPath`, or null.
 *
 * Null is an ordinary answer, not a failure: a project with no Claude Code
 * session, a host with nothing mounted at the config root, a session started
 * some other way. The caller falls back to the terminal monitors, which is what
 * it did before this module existed.
 */
export async function resolveTranscript(
  projectPath: string,
  root: string = claudeConfigRoot(),
): Promise<string | null> {
  const wanted = normalizePath(projectPath);
  const candidates = await listTranscripts(root);

  let examined = 0;
  for (const candidate of candidates) {
    if (examined >= MAX_CANDIDATES) break;
    examined++;
    const cwd = declaredCwd(await readHead(candidate.path));
    if (cwd && normalizePath(cwd) === wanted) return candidate.path;
  }
  return null;
}

/**
 * An incremental reader over one transcript.
 *
 * Two things it must get right, and both were mistakes waiting to be made:
 *
 * - A line is only a line once its newline has arrived. The writer emits an
 *   object with one `write`, but the reader can still catch it split across two
 *   reads, and half an object parses as nothing at best. The unterminated
 *   remainder is held and prepended to the next read.
 *
 * - A file that shrank is not the same file. A session ended and a new one took
 *   the name, or the log was truncated; either way the stored offset now points
 *   into the middle of unrelated bytes. Reading resumes from the start, which is
 *   cheap precisely because the file just became small.
 */
export class TranscriptTail {
  private partial = "";

  private constructor(readonly path: string, private offset: number) {}

  /** Start reading from the end — see the note on this module. */
  static async atEnd(path: string): Promise<TranscriptTail> {
    const size = await stat(path).then((s) => s.size).catch(() => 0);
    return new TranscriptTail(path, size);
  }

  /** Start from a known byte offset. For tests, and for resuming a known file. */
  static at(path: string, offset: number): TranscriptTail {
    return new TranscriptTail(path, Math.max(0, offset));
  }

  /** Where the next read will begin. */
  get position(): number {
    return this.offset;
  }

  /** Complete lines appended since the last call. Empty when nothing was written. */
  async read(): Promise<string[]> {
    const size = await stat(this.path).then((s) => s.size).catch(() => null);
    if (size === null) return [];

    if (size < this.offset) {
      // Truncated or replaced. The held fragment belongs to a file that no
      // longer exists — carrying it would splice two files together.
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return [];

    const handle = await open(this.path, "r").catch(() => null);
    if (!handle) return [];

    try {
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;

      const combined = this.partial + buffer.subarray(0, bytesRead).toString("utf8");
      const parts = combined.split("\n");
      // The last piece has no newline yet: it is either empty, or the front half
      // of an object the writer has not finished. Held for the next read.
      this.partial = parts.pop() ?? "";
      return parts.filter((line) => line.trim().length > 0);
    } catch {
      return [];
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

/** One line to an entry, or null. Malformed input is ordinary here — a mid-write read produces it. */
export function parseEntry(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as TranscriptEntry;
  } catch {
    return null;
  }
}

/**
 * Where a subagent writes, and what to call it.
 *
 * The status reads the session's own transcript. A subagent does not write to
 * it: its record lives one directory down, at
 * `<project>/<session-uuid>/subagents/agent-<id>.jsonl`, with
 * `agent-<id>.meta.json` beside it carrying `agentType`, `description` and
 * `spawnDepth`. `resolveTranscript` lists `projects/<dir>/*.jsonl` — one level,
 * files only — so none of that was ever seen.
 *
 * The consequence the operator reported: an agent says "запускаю сабагентов"
 * and the status goes still. Not wrong — motionless, which reads as hung.
 *
 * File access is injected for the same reason it is in `transcript-locate.ts`:
 * these tests must not depend on the operator's real `~/.claude`, and a fake
 * tree is the only way to state the layout as an assertion.
 */

import { join, dirname, basename } from "path";

/** How many subagents are followed at once. */
export const MAX_TRACKED_AGENTS = 3;

/** Characters of `description` used when there is no `agentType`. */
export const LABEL_CHARS = 24;

export interface SubagentFile {
  /** Absolute path of the subagent's transcript. */
  path: string;
  /** The id in the filename — `agent-<id>.jsonl`. */
  agentId: string;
  /** What to print in front of its lines. */
  label: string;
  mtimeMs: number;
}

/** The file operations this module needs, so a test can supply a tree. */
export interface FileAccess {
  readdir: (dir: string) => Promise<string[]>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  readFile: (path: string) => Promise<string>;
}

/**
 * The directory a session's subagents write into.
 *
 * Derived from the parent transcript rather than resolved independently: the
 * monitor has already found that file, and the layout is a sibling directory
 * named after it. Guessing a second time is how the two could disagree.
 */
export function subagentDir(parentTranscript: string): string {
  const dir = dirname(parentTranscript);
  const uuid = basename(parentTranscript).replace(/\.jsonl$/, "");
  return join(dir, uuid, "subagents");
}

/**
 * What to print in front of a subagent's lines.
 *
 * Without a label a subagent's line reads as the main agent contradicting
 * itself — two files being edited at once by something supposed to be doing one
 * thing. `agentType` is the name the operator chose; the description's opening
 * words are the fallback, and the bare id is the last resort, because a line
 * attributed to nobody is worse than a line attributed to `a1b2c3`.
 */
export function labelFor(meta: unknown, agentId: string): string {
  if (meta && typeof meta === "object") {
    const record = meta as Record<string, unknown>;
    const type = record.agentType;
    if (typeof type === "string" && type.trim()) return type.trim();
    const description = record.description;
    if (typeof description === "string" && description.trim()) {
      const text = description.trim();
      if (text.length <= LABEL_CHARS) return text;
      // Cut at a word, not through one: "Research helyx message q…" reads as a
      // typo, and the label sits in front of every line the agent produces.
      const clipped = text.slice(0, LABEL_CHARS);
      const lastSpace = clipped.lastIndexOf(" ");
      return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
    }
  }
  return agentId;
}

/**
 * The subagents worth following: newest first, capped, none of them stale.
 *
 * `since` is the turn's start. A subagent file from a previous session still
 * opens and still reports an end — the same trap `TRANSCRIPT_STALE_MS` was
 * added for after review — and reading one would attribute yesterday's work to
 * this turn.
 */
export async function findSubagents(
  parentTranscript: string,
  options: { since: number; files: FileAccess; max?: number },
): Promise<SubagentFile[]> {
  const dir = subagentDir(parentTranscript);
  let names: string[];
  try {
    names = await options.files.readdir(dir);
  } catch {
    // No fan-out has ever run for this session; the directory is created with
    // the first subagent.
    return [];
  }

  const found: SubagentFile[] = [];
  for (const name of names) {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (!match) continue;
    const agentId = match[1]!;
    const path = join(dir, name);

    let mtimeMs: number;
    try {
      mtimeMs = (await options.files.stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < options.since) continue;

    let meta: unknown = null;
    try {
      meta = JSON.parse(await options.files.readFile(join(dir, `agent-${agentId}.meta.json`)));
    } catch {
      // Missing or malformed: the label falls back, and a fan-out is still
      // worth showing without its name.
    }

    found.push({ path, agentId, label: labelFor(meta, agentId), mtimeMs });
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, options.max ?? MAX_TRACKED_AGENTS);
}

/**
 * A subagent's line, marked with whose it is.
 *
 * The marker goes in front of the whole line rather than replacing the bullet:
 * the bullet is what `status-render.ts` and the tool counters key on, and a
 * line that stopped looking like a tool call would stop being counted as one.
 */
export function markLines(label: string, lines: readonly string[]): string[] {
  return lines.map((line) => {
    const bullet = /^([●·⎿]\s*)(.*)$/s.exec(line);
    return bullet ? `${bullet[1]}[${label}] ${bullet[2]}` : `[${label}] ${line}`;
  });
}

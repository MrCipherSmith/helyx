/**
 * What a session is doing, answered without asking it.
 *
 * The operator's most frequent question is the one the system was worst at
 * answering. Asking goes through `message_queue`, and the poller holds a
 * message back while the chat is busy — deliberately, so each message gets its
 * own turn — so the answer arrives when the turn ends, which is when it stops
 * being interesting. A stuck session never answers at all.
 *
 * And it was never necessary: the transcript already says what the session is
 * doing, and since flow 045 it says what its subagents are doing too. This
 * reads that record and answers from it — no message queued, no turn taken, no
 * model consulted.
 *
 * Everything here is derived from the record or absent. A field that would have
 * to be guessed is `null`, because a snapshot that invents is worse than one
 * that admits.
 */

import { parseEntry, type TranscriptEntry } from "./transcript-locate.ts";
import { renderEntry } from "./transcript-events.ts";

/** What the session is up against, in the order an operator cares about. */
export type Waiting =
  /** A permission prompt is on screen and nothing moves until it is answered. */
  | "permission"
  /** A question was put to the operator and the session is holding for it. */
  | "question"
  /** Working: something was written recently. */
  | "working"
  /** Nothing has happened for a while. */
  | "idle";

/** How long without a line before a session counts as idle. */
export const IDLE_AFTER_MS = 90_000;

export interface AgentActivity {
  label: string;
  /** The last thing this agent did, as the status would render it. */
  lastLine: string | null;
  /** Milliseconds since it did it, or null when the record carries no time. */
  agoMs: number | null;
}

export interface SessionSnapshot {
  /** False when there is no transcript to read — a session that never started. */
  found: boolean;
  /** The last thing the session did, rendered. */
  lastLine: string | null;
  /** Milliseconds since that line, or null when nothing carried a timestamp. */
  agoMs: number | null;
  /** Tool calls seen in the window read. */
  tools: number;
  /** Distinct files touched in the window read. */
  files: number;
  /** What it is waiting on. */
  waiting: Waiting;
  /** The subagents that have written in the window, newest first. */
  agents: AgentActivity[];
}

/** An empty answer, for a project with nothing to read. */
export const NO_SESSION: SessionSnapshot = {
  found: false,
  lastLine: null,
  agoMs: null,
  tools: 0,
  files: 0,
  waiting: "idle",
  agents: [],
};

/** Milliseconds since an entry's timestamp, or null when it has none. */
function agoOf(entry: TranscriptEntry, now: number): number | null {
  const raw = entry.timestamp;
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, now - at);
}

/** The tool name an entry calls, if it calls one. */
function toolOf(entry: TranscriptEntry): { name: string; input: Record<string, unknown> } | null {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type !== "tool_use" || typeof block.name !== "string") continue;
    return { name: block.name, input: (block.input as Record<string, unknown>) ?? {} };
  }
  return null;
}

/**
 * What a session is waiting on, from the record and the clock.
 *
 * The three states mean different things to an operator deciding whether to
 * wait: a permission prompt and an open question will sit for ever until
 * someone answers, and an idle session is done or wedged. Reading them as one
 * "not working" would throw away the whole reason for asking.
 */
export function waitingFrom(
  facts: {
    lastTool: string | null;
    agoMs: number | null;
    openQuestion: boolean;
    /**
     * A real permission prompt is on screen right now, sourced by the caller
     * (e.g. a pending `permission_requests` row for this session) — this
     * module only reads the transcript, which carries no signal of its own
     * for "blocked on approval" versus "still running". Defaults to false so
     * every existing caller that doesn't pass it keeps today's behavior.
     */
    awaitingPermission?: boolean;
  },
  idleAfterMs: number = IDLE_AFTER_MS,
): Waiting {
  // Checked first: a permission prompt blocks everything else the same way
  // an open question does, and takes priority the same way status-format.ts's
  // resolvePhase() latches "waiting" over its other phase checks.
  if (facts.awaitingPermission) return "permission";
  if (facts.openQuestion) return "question";
  // The hook that puts a permission prompt on screen is the last thing written
  // before everything stops, so the tool is still the newest entry.
  if (facts.lastTool === "AskUserQuestion") return "question";
  if (facts.agoMs !== null && facts.agoMs >= idleAfterMs) return "idle";
  return "working";
}

export interface SnapshotInput {
  /** The tail of the session's transcript, newest last. One JSON object per line. */
  lines: readonly string[];
  /** Lines from subagent transcripts, already labelled by `markLines`. */
  agents?: readonly { label: string; lines: readonly string[] }[];
  /** Is a question waiting for the operator right now? */
  openQuestion?: boolean;
  /** Is a real permission prompt waiting for the operator right now? */
  awaitingPermission?: boolean;
  now: number;
  idleAfterMs?: number;
}

/**
 * Read a window of transcript into an answer.
 *
 * The window is whatever the caller read — this does not decide how far back to
 * look, because the caller knows what it opened and this would only guess.
 */
export function snapshotFrom(input: SnapshotInput): SessionSnapshot {
  if (input.lines.length === 0 && !(input.agents ?? []).length) return NO_SESSION;

  let lastLine: string | null = null;
  let agoMs: number | null = null;
  let lastTool: string | null = null;
  let tools = 0;
  const files = new Set<string>();

  for (const raw of input.lines) {
    const entry = parseEntry(raw);
    if (!entry) continue;

    const tool = toolOf(entry);
    if (tool) {
      tools++;
      lastTool = tool.name;
      const path = tool.input.file_path ?? tool.input.path ?? tool.input.notebook_path;
      if (typeof path === "string") files.add(path);
    }

    const rendered = renderEntry(entry);
    if (rendered.length > 0) {
      lastLine = rendered[rendered.length - 1]!;
      agoMs = agoOf(entry, input.now) ?? agoMs;
    }
  }

  const agents: AgentActivity[] = (input.agents ?? []).map((agent) => ({
    label: agent.label,
    lastLine: agent.lines.length > 0 ? agent.lines[agent.lines.length - 1]! : null,
    agoMs: null,
  }));

  return {
    found: true,
    lastLine,
    agoMs,
    tools,
    files: files.size,
    waiting: waitingFrom(
      {
        lastTool,
        agoMs,
        openQuestion: input.openQuestion ?? false,
        awaitingPermission: input.awaitingPermission ?? false,
      },
      input.idleAfterMs,
    ),
    agents,
  };
}

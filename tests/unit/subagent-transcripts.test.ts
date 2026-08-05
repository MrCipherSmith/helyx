/**
 * Where a subagent writes, and what the status calls it.
 *
 * The operator's report, second half: an agent says "запускаю сабагентов" and
 * the status goes still. Flow 044 keeps the status alive past the reply; this
 * is what gives it something to say.
 *
 * A subagent's record is not in the session transcript. It is one directory
 * down — `<project>/<session-uuid>/subagents/agent-<id>.jsonl`, with
 * `agent-<id>.meta.json` beside it — and `resolveTranscript` lists
 * `projects/<dir>/*.jsonl`, one level, files only. So the parent transcript
 * receives nothing at all while a fan-out runs.
 *
 * The layout is Claude Code's, not ours. It is stated here as assertions so
 * that if it ever changes, the failure names itself instead of the feature
 * quietly going silent.
 */

import { describe, test, expect } from "bun:test";
import {
  subagentDir,
  labelFor,
  findSubagents,
  selectAgents,
  markLines,
  type FileAccess,
} from "../../utils/subagent-transcripts.ts";

const PARENT = "/root/projects/-home-altsay-bots-helyx/2d056693-c3d6.jsonl";
const DIR = "/root/projects/-home-altsay-bots-helyx/2d056693-c3d6/subagents";
const NOW = 1_800_000_000_000;

/** A tree, as the operator's `~/.claude` would have it. */
function tree(entries: Record<string, { mtimeMs?: number; content?: string }>): FileAccess {
  return {
    readdir: async (dir) => {
      const names = Object.keys(entries)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1))
        .filter((n) => !n.includes("/"));
      if (names.length === 0) throw new Error("ENOENT");
      return names;
    },
    stat: async (path) => {
      const entry = entries[path];
      if (!entry) throw new Error("ENOENT");
      return { mtimeMs: entry.mtimeMs ?? NOW };
    },
    readFile: async (path) => {
      const entry = entries[path];
      if (entry?.content === undefined) throw new Error("ENOENT");
      return entry.content;
    },
  };
}

const meta = (over: Record<string, unknown>) => JSON.stringify({ spawnDepth: 1, ...over });

describe("where they are", () => {
  test("beside the transcript, in a directory named after it", () => {
    expect(subagentDir(PARENT)).toBe(DIR);
  });

  test("a session with no fan-out has no directory, and that is not an error", async () => {
    const files = await findSubagents(PARENT, { since: 0, files: tree({}) });

    expect(files).toEqual([]);
  });
});

describe("which ones are read", () => {
  test("the ones written during this turn", async () => {
    const files = tree({
      [`${DIR}/agent-a1.jsonl`]: { mtimeMs: NOW },
      [`${DIR}/agent-a1.meta.json`]: { content: meta({ agentType: "Explore" }) },
    });

    const found = await findSubagents(PARENT, { since: NOW - 1_000, files });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ agentId: "a1", label: "Explore", path: `${DIR}/agent-a1.jsonl` });
  });

  test("yesterday's fan-out is not this turn's work", async () => {
    // A file from a previous session still opens and still reports an end —
    // the same trap `TRANSCRIPT_STALE_MS` was added for after review. Reading
    // it would attribute someone else's work to this turn.
    const files = tree({
      [`${DIR}/agent-old.jsonl`]: { mtimeMs: NOW - 86_400_000 },
      [`${DIR}/agent-new.jsonl`]: { mtimeMs: NOW },
    });

    const found = await findSubagents(PARENT, { since: NOW - 1_000, files });

    expect(found.map((f) => f.agentId)).toEqual(["new"]);
  });

  test("only the transcripts, not what sits beside them", async () => {
    const files = tree({
      [`${DIR}/agent-a1.jsonl`]: {},
      [`${DIR}/agent-a1.meta.json`]: { content: meta({ agentType: "Explore" }) },
      [`${DIR}/notes.txt`]: {},
    });

    const found = await findSubagents(PARENT, { since: 0, files });

    expect(found.map((f) => f.agentId)).toEqual(["a1"]);
  });

  test("they come back newest first", async () => {
    const entries: Record<string, { mtimeMs?: number }> = {};
    for (let i = 0; i < 10; i++) entries[`${DIR}/agent-a${i}.jsonl`] = { mtimeMs: NOW - i * 1_000 };

    const found = await findSubagents(PARENT, { since: 0, files: tree(entries) });

    expect(found.map((f) => f.agentId).slice(0, 3)).toEqual(["a0", "a1", "a2"]);
  });
});

describe("which of a wide fan-out is followed", () => {
  const agent = (id: string, mtimeMs: number) => ({ path: `${DIR}/agent-${id}.jsonl`, agentId: id, label: id, mtimeMs });
  const wide = [agent("a", NOW), agent("b", NOW - 1_000), agent("c", NOW - 2_000), agent("d", NOW - 3_000)];

  test("the newest, when nothing is being followed yet", async () => {
    // Thirty agents would be thirty tails and thirty times the lines, and the
    // operator can read neither.
    expect(selectAgents(wide, new Set()).map((f) => f.agentId)).toEqual(["a", "b", "c"]);
  });

  test("an agent already being followed keeps its place, however quiet it goes", () => {
    // Raised in review, and it is the same defect as the one this flow fixes,
    // in miniature: an agent that writes rarely would fall out of the newest
    // three and its progress would never be shown, however long it ran.
    const quiet = [agent("a", NOW), agent("b", NOW - 1_000), agent("c", NOW - 2_000), agent("slow", NOW - 60_000)];

    const chosen = selectAgents(quiet, new Set(["slow"])).map((f) => f.agentId);

    expect(chosen).toContain("slow");
  });

  test("the set does not reshuffle under the operator, and so is never re-read", () => {
    // The other half of the same finding: a tail dropped and re-created starts
    // at offset zero, so its lines arrive twice and its tokens are counted
    // twice. Stability is what prevents that, not a special case for it.
    const first = selectAgents(wide, new Set()).map((f) => f.agentId);
    // "d" is newest now; the three already followed still are.
    const later = [agent("d", NOW), agent("a", NOW - 5_000), agent("b", NOW - 6_000), agent("c", NOW - 7_000)];

    expect(selectAgents(later, new Set(first)).map((f) => f.agentId).sort()).toEqual(["a", "b", "c"]);
  });

  test("an agent that has gone away frees its slot", () => {
    const remaining = [agent("a", NOW), agent("d", NOW - 500)];

    expect(selectAgents(remaining, new Set(["a", "b", "c"])).map((f) => f.agentId)).toEqual(["a", "d"]);
  });
});

describe("what they are called", () => {
  test("the agent type, when it has one", () => {
    expect(labelFor({ agentType: "code-reviewer" }, "a1")).toBe("code-reviewer");
  });

  test("the description's opening words, when it does not", () => {
    expect(labelFor({ description: "Research helyx message queue behaviour" }, "a1"))
      .toBe("Research helyx message…");
  });

  test("the id, when there is nothing else", () => {
    // A line attributed to nobody reads as the main agent contradicting
    // itself; attributed to `a1b2c3` it at least reads as somebody.
    expect(labelFor(null, "a1b2c3")).toBe("a1b2c3");
    expect(labelFor({}, "a1b2c3")).toBe("a1b2c3");
    expect(labelFor({ agentType: "   " }, "a1b2c3")).toBe("a1b2c3");
  });

  test("a meta file that is missing or malformed costs the name, not the lines", async () => {
    const files = tree({
      [`${DIR}/agent-broken.jsonl`]: {},
      [`${DIR}/agent-broken.meta.json`]: { content: "{not json" },
      [`${DIR}/agent-bare.jsonl`]: {},
    });

    const found = await findSubagents(PARENT, { since: 0, files });

    expect(found.map((f) => f.label).sort()).toEqual(["bare", "broken"]);
  });
});

describe("marking the lines", () => {
  test("the label goes after the bullet, not over it", () => {
    // The bullet is what the renderer and the tool counters key on; a line
    // that stopped looking like a tool call would stop being counted as one.
    expect(markLines("Explore", ["● Read: channel/status.ts"]))
      .toEqual(["● [Explore] Read: channel/status.ts"]);
    expect(markLines("Explore", ["⎿ 40 lines"])).toEqual(["⎿ [Explore] 40 lines"]);
  });

  test("a line with no bullet is still attributed", () => {
    expect(markLines("Explore", ["thinking about it"])).toEqual(["[Explore] thinking about it"]);
  });
});

/**
 * A fan-out, as the status sees it.
 *
 * `subagent-transcripts.test.ts` states the layout; this drives the real
 * `TranscriptSession` over a real directory tree, because the defect the
 * operator reported is not in either half alone — it is that the monitor polled
 * one file and a subagent wrote to another, and the parent file stayed empty
 * for exactly as long as the fan-out ran.
 *
 * Files on disk rather than a fake tree here: the monitor's tails do real
 * incremental reads, and a fixture that answered from memory would be testing
 * the fixture.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TranscriptSession } from "../../utils/transcript-monitor.ts";

const PROJECT = "/home/someone/bots/helyx";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helyx-subagents-"));
  mkdirSync(join(root, "projects"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const assistant = (text: string) => ({
  type: "assistant",
  cwd: PROJECT,
  message: { content: [{ type: "text", text }] },
});

const toolCall = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  cwd: PROJECT,
  message: { content: [{ type: "tool_use", name, input }] },
});

/** The session's own transcript, and the directory its subagents write into. */
function session(name = "abc123"): { path: string; agents: string } {
  const dir = join(root, "projects", "slug");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "system", cwd: PROJECT })}\n`);
  const when = new Date(Date.now() - 1_000);
  utimesSync(path, when, when);
  const agents = join(dir, name, "subagents");
  mkdirSync(agents, { recursive: true });
  return { path, agents };
}

function spawnAgent(agents: string, id: string, meta: Record<string, unknown> | null, entries: unknown[] = []): string {
  const path = join(agents, `agent-${id}.jsonl`);
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  if (meta) writeFileSync(join(agents, `agent-${id}.meta.json`), JSON.stringify(meta));
  return path;
}

const append = (path: string, entry: unknown) => appendFileSync(path, `${JSON.stringify(entry)}\n`);

describe("a session that spawned subagents", () => {
  test("their work reaches the status while the parent transcript says nothing", async () => {
    // The reported case. The parent writes the Task call and then nothing at
    // all until the tool returns; everything in between is in another file.
    const { path, agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0 });
    await monitor.attach();

    append(path, toolCall("Task", { description: "explore the status path" }));
    await monitor.poll();

    const agent = spawnAgent(agents, "a1", { agentType: "Explore", spawnDepth: 1 });
    append(agent, toolCall("Read", { file_path: "channel/status.ts" }));

    const block = await monitor.poll();

    expect(block).toContain("Explore");
    expect(block).toContain("status.ts");
  });

  test("each line says which agent produced it", async () => {
    // Unmarked, a fan-out reads as the main agent editing two files at once.
    const { agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0 });
    await monitor.attach();

    const one = spawnAgent(agents, "a1", { agentType: "Explore" });
    const two = spawnAgent(agents, "a2", { agentType: "code-reviewer" });
    append(one, toolCall("Read", { file_path: "one.ts" }));
    append(two, toolCall("Read", { file_path: "two.ts" }));

    const block = await monitor.poll();

    expect(block).toContain("[Explore]");
    expect(block).toContain("[code-reviewer]");
  });

  test("an agent with no meta file is still shown, under its id", async () => {
    const { agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0 });
    await monitor.attach();

    const bare = spawnAgent(agents, "bare1", null);
    append(bare, assistant("looking into it"));

    expect(await monitor.poll()).toContain("[bare1]");
  });

  test("the parent's own lines are not crowded out by a fan-out", async () => {
    // The buffer keeps the newest and drops the oldest, so a chatty fan-out
    // could push the parent's own work off the block entirely. The parent's
    // line is written last here, which is the order that matters: what the
    // operator is watching is what the session did most recently.
    const { path, agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0 });
    await monitor.attach();

    const agent = spawnAgent(agents, "a1", { agentType: "Explore" });
    for (let i = 0; i < 30; i++) append(agent, toolCall("Read", { file_path: `file${i}.ts` }));
    append(path, assistant("collecting what they found"));

    const block = await monitor.poll();

    expect(block).toContain("collecting what they found");
    // And the fan-out is in there too. Without this the test passes with the
    // whole feature removed, which review pointed out is false confidence.
    expect(block).toContain("[Explore]");
  });

  test("an agent that stops being listed is dropped rather than tailed for ever", async () => {
    const { agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0 });
    await monitor.attach();

    const agent = spawnAgent(agents, "a1", { agentType: "Explore" });
    append(agent, toolCall("Read", { file_path: "one.ts" }));
    expect(await monitor.poll()).toContain("[Explore]");

    rmSync(agent);
    // Nothing left to read and nothing to say — the poll must not throw on the
    // file that went away, which is what a tail held for ever would do.
    expect(await monitor.poll()).toBeNull();
  });

  test("a fan-out from a previous session is not this turn's work", async () => {
    // A file from yesterday still opens and still reports an end. Reading it
    // would put someone else's work in this operator's status.
    const { agents } = session();
    const old = spawnAgent(agents, "yesterday", { agentType: "Explore" }, [
      toolCall("Read", { file_path: "ancient.ts" }),
    ]);
    const when = new Date(Date.now() - 86_400_000);
    utimesSync(old, when, when);

    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: Date.now() - 60_000 });
    await monitor.attach();

    expect(await monitor.poll()).toBeNull();
  });

  test("the turn's tokens include what the subagents spent", async () => {
    // A header showing only the parent's output would report a fraction of what
    // the turn cost while three agents ran. Stated as a test because it is a
    // decision, not an accident.
    const { agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0 });
    await monitor.attach();

    const agent = spawnAgent(agents, "a1", { agentType: "Explore" });
    append(agent, {
      type: "assistant",
      cwd: PROJECT,
      message: { content: [{ type: "text", text: "found it" }], usage: { output_tokens: 1234 } },
    });

    const block = await monitor.poll();

    // Rendered as the header renders any total — 1.2k, not 1234.
    expect(block).toContain("1.2k tokens");
  });

  test("an agent whose file goes away and returns is not read twice", async () => {
    // The tail is dropped when the file stops being listed; re-created at zero
    // it would replay every line and count every token again. The offset is
    // remembered — and `TranscriptTail` still refuses one that is not a record
    // boundary, so a genuinely new file at the same path starts over.
    const { agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, maxAgents: 1, subagentsSince: 0 });
    await monitor.attach();

    const first = spawnAgent(agents, "a1", { agentType: "Explore" });
    append(first, toolCall("Read", { file_path: "only-once.ts" }));
    expect(await monitor.poll()).toContain("only-once.ts");

    // It leaves the listing and comes back with the same content.
    const saved = readFileSync(first);
    rmSync(first);
    await monitor.poll();
    writeFileSync(first, saved);

    const block = await monitor.poll();

    expect(block).toBeNull();
  });

  test("a fan-out cannot push the session's own work off the block", async () => {
    // The buffer keeps the newest lines and drops the oldest, so the order the
    // two sources are pushed in decides who survives a wide fan-out. The parent
    // goes last. Raised in review: the earlier test only proved it for a buffer
    // with room to spare.
    const { path, agents } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0, bufferLines: 5 });
    await monitor.attach();

    append(path, assistant("what the session itself is doing"));
    const agent = spawnAgent(agents, "a1", { agentType: "Explore" });
    for (let i = 0; i < 20; i++) append(agent, toolCall("Read", { file_path: `file${i}.ts` }));

    const block = await monitor.poll();

    expect(block).toContain("what the session itself is doing");
  });

  test("a session with no fan-out behaves exactly as it did", async () => {
    const { path } = session();
    const monitor = new TranscriptSession(PROJECT, { root, subagentsSince: 0 });
    await monitor.attach();

    append(path, assistant("working alone"));

    expect(await monitor.poll()).toContain("working alone");
  });
});

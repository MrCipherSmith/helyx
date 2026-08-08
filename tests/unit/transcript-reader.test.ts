/**
 * Finding the right transcript, and reading it forward without breaking it.
 *
 * Everything here is about a file someone else is writing to, concurrently, in a
 * format that is not ours. The three ways that goes wrong are the three things
 * under test: picking the wrong file, replaying a session's whole history into a
 * status message, and parsing half of an object that was caught mid-write.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTranscript,
  declaredCwd,
  parseEntry,
  claudeConfigRoot,
  TranscriptTail,
} from "../../utils/transcript-locate.ts";
import { TranscriptSession, LineBuffer, RERESOLVE_AFTER_EMPTY_POLLS } from "../../utils/transcript-monitor.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helyx-transcript-"));
  mkdirSync(join(root, "projects"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a transcript under an arbitrary slug directory, declaring `cwd`. */
function writeTranscript(slug: string, name: string, cwd: string, entries: unknown[] = []): string {
  const dir = join(root, "projects", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const lines = [{ type: "system", cwd }, ...entries].map((e) => JSON.stringify(e));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** Age a file so mtime ordering is deterministic rather than a race. */
function age(path: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
}

function appendEntry(path: string, entry: unknown): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

const PROJECT = "/home/someone/bots/helyx";

function assistantEntry(content: unknown[], usage?: Record<string, unknown>) {
  return { type: "assistant", cwd: PROJECT, message: { content, ...(usage ? { usage } : {}) } };
}

describe("claudeConfigRoot", () => {
  test("the mount point when the bot runs in a container", () => {
    expect(claudeConfigRoot({ HOST_CLAUDE_CONFIG: "/host-claude-config" }))
      .toBe("/host-claude-config");
  });

  test("the real home otherwise", () => {
    expect(claudeConfigRoot({})).toMatch(/\.claude$/);
  });
});

describe("declaredCwd", () => {
  test("read from the file rather than derived from its directory name", () => {
    expect(declaredCwd('{"type":"system","cwd":"/a/b"}\n')).toBe("/a/b");
  });

  test("a fragment at the head does not disqualify the file", () => {
    // A read that landed mid-write starts with half an object. The next line is
    // still a whole one.
    expect(declaredCwd('{"type":"system","cw\n{"type":"user","cwd":"/a/b"}\n')).toBe("/a/b");
  });

  test("nothing parseable, or nothing with a cwd", () => {
    expect(declaredCwd("")).toBeNull();
    expect(declaredCwd("not json at all\n")).toBeNull();
    expect(declaredCwd('{"type":"system"}\n')).toBeNull();
  });
});

describe("resolveTranscript", () => {
  test("matches on the cwd inside the file, not on the directory name", async () => {
    // The decoy's directory name is exactly what a naive slug derivation would
    // produce for PROJECT; the real file sits under a name that derivation would
    // never guess. Getting this right is the whole reason resolution reads the
    // file.
    const decoy = writeTranscript("-home-someone-bots-helyx", "decoy.jsonl", "/somewhere/else");
    age(decoy, 1);
    const real = writeTranscript("an-encoding-nobody-predicted", "real.jsonl", PROJECT);
    age(real, 2);

    expect(await resolveTranscript(PROJECT, root)).toBe(real);
  });

  test("the newest of several for the same project", async () => {
    const older = writeTranscript("slug", "older.jsonl", PROJECT);
    age(older, 600);
    const newer = writeTranscript("slug", "newer.jsonl", PROJECT);
    age(newer, 1);

    expect(await resolveTranscript(PROJECT, root)).toBe(newer);
  });

  test("a trailing slash is the same directory", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 1);
    expect(await resolveTranscript(`${PROJECT}/`, root)).toBe(path);
  });

  test("no match is null, not a throw — the caller falls back to tmux", async () => {
    writeTranscript("slug", "a.jsonl", "/some/other/project");
    expect(await resolveTranscript(PROJECT, root)).toBeNull();
  });

  test("a transcript nobody has written to in a long time is not this session's", async () => {
    // Raised in review: attaching always succeeds, because a dead file still
    // opens and still reports an end. A project whose last session was days ago
    // would sit on it and never fall back to the terminal monitors — an empty
    // status rather than a wrong one, which is harder to notice.
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 60 * 60 * 24); // a day

    expect(await resolveTranscript(PROJECT, root, { maxAgeMs: 60_000 })).toBeNull();
    expect(await resolveTranscript(PROJECT, root, { maxAgeMs: 60 * 60 * 48 * 1000 })).toBe(path);
    expect(await resolveTranscript(PROJECT, root)).toBe(path); // no bound asked for, no bound applied
  });

  test("a config root that does not exist is null", async () => {
    expect(await resolveTranscript(PROJECT, join(root, "nope"))).toBeNull();
  });

  test("non-jsonl files in the directory are ignored", async () => {
    const dir = join(root, "projects", "slug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), JSON.stringify({ cwd: PROJECT }));
    expect(await resolveTranscript(PROJECT, root)).toBeNull();
  });
});

describe("parseEntry", () => {
  test("an object", () => {
    expect(parseEntry('{"type":"assistant"}')?.type).toBe("assistant");
  });

  test("a half-written line, a blank, or valid JSON that is not an object", () => {
    expect(parseEntry('{"type":"assist')).toBeNull();
    expect(parseEntry("   ")).toBeNull();
    expect(parseEntry("[1,2]")).toBeNull();
    expect(parseEntry("42")).toBeNull();
    expect(parseEntry("null")).toBeNull();
  });
});

describe("TranscriptTail", () => {
  test("starting at the end skips the history", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT, [
      { type: "assistant", note: "old" },
      { type: "assistant", note: "older" },
    ]);

    const tail = await TranscriptTail.atEnd(path);
    expect(await tail.read()).toEqual([]);

    appendEntry(path, { type: "assistant", note: "new" });
    const lines = await tail.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("new");
  });

  test("an approximate offset reads the tail, not the whole file", async () => {
    // `at()` demands a real record boundary and answers anything else by
    // rewinding to zero. A caller asking for "roughly the last N bytes" cannot
    // name a boundary — it does not know where the lines are — so every such
    // caller was reading the entire file. `readSessionContext` did this per
    // active session every two minutes, on transcripts of tens of megabytes,
    // inside the bot process.
    const entries = Array.from({ length: 200 }, (_, i) => ({ type: "assistant", note: `line-${i}` }));
    const path = writeTranscript("slug", "a.jsonl", PROJECT, entries);
    const size = statSync(path).size;

    // Deliberately mid-record: half way through the file, wherever that lands.
    const tail = await TranscriptTail.near(path, Math.floor(size / 2));
    const lines = await tail.read();

    // Not the whole file, and not a spliced fragment: every line read is whole.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(entries.length);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // And it is the *tail* — the last entry is present, the first is not.
    expect(lines.at(-1)).toContain("line-199");
    expect(lines.join("\n")).not.toContain("line-0\"");
  });

  test("an offset past the end, or a file with no newline after it, starts from the beginning", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT, [{ type: "assistant", note: "only" }]);
    const size = statSync(path).size;

    // Both read the file whole rather than from a nonsense offset.
    const past = await TranscriptTail.near(path, size + 10_000);
    expect((await past.read()).join("\n")).toContain("only");

    const zero = await TranscriptTail.near(path, 0);
    expect((await zero.read()).join("\n")).toContain("only");
  });

  test("an unterminated line is held, not parsed as half an object", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    const tail = await TranscriptTail.atEnd(path);

    // The writer is mid-object.
    appendFileSync(path, '{"type":"assistant","note":"spl');
    expect(await tail.read()).toEqual([]);

    // …and finishes it.
    appendFileSync(path, 'it"}\n');
    const lines = await tail.read();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).note).toBe("split");
  });

  test("a file that shrank is read from the start", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT, [{ type: "assistant", note: "one" }]);
    const tail = await TranscriptTail.atEnd(path);
    expect(tail.position).toBeGreaterThan(0);

    // Truncated and rewritten — a new session took the name. The stored offset
    // now points into unrelated bytes.
    writeFileSync(path, `${JSON.stringify({ type: "assistant", note: "fresh" })}\n`);
    const lines = await tail.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fresh");
  });

  test("a fragment from a replaced file is not spliced onto the new one", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    const tail = await TranscriptTail.atEnd(path);
    appendFileSync(path, '{"type":"assistant","note":"aband');
    expect(await tail.read()).toEqual([]);

    writeFileSync(path, `${JSON.stringify({ type: "assistant", note: "fresh" })}\n`);
    const lines = await tail.read();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).note).toBe("fresh");
  });

  test("a different file at the same path is read from its start", async () => {
    // Raised in review: the size check only fires when the new file is
    // *smaller*. Delete and recreate with more bytes and the offset points into
    // the middle of a file it never read the beginning of.
    const path = writeTranscript("slug", "a.jsonl", PROJECT, [{ type: "assistant", note: "one" }]);
    const tail = await TranscriptTail.atEnd(path);

    rmSync(path);
    const longer = [
      { type: "assistant", note: "fresh one" },
      { type: "assistant", note: "fresh two" },
      { type: "assistant", note: "fresh three" },
    ].map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(path, `${longer}\n`);

    const lines = await tail.read();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("fresh one");
  });

  test("a character split across two reads survives", async () => {
    // Raised in review: decoding each byte range on its own turns both halves
    // of a split emoji into replacement characters. The transcript's reasoning
    // lines are exactly where emoji live.
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    const tail = await TranscriptTail.atEnd(path);

    const record = Buffer.from(`${JSON.stringify({ type: "assistant", note: "🧠 thinking" })}\n`, "utf8");
    // Split *inside* the emoji, not merely somewhere in the record: the four
    // bytes of U+1F9E0 begin with 0xF0, and the cut goes two bytes in.
    const emojiStart = record.indexOf(0xf0);
    expect(emojiStart).toBeGreaterThan(0);
    const split = emojiStart + 2;
    appendFileSync(path, record.subarray(0, split));
    expect(await tail.read()).toEqual([]);
    appendFileSync(path, record.subarray(split));

    const lines = await tail.read();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).note).toBe("🧠 thinking");
    expect(lines[0]).not.toContain("�");
  });

  test("a file that vanished is empty, not an error", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    const tail = await TranscriptTail.atEnd(path);
    rmSync(path);
    expect(await tail.read()).toEqual([]);
  });

  test("nothing new is nothing, repeatedly", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    const tail = TranscriptTail.at(path, 0);
    expect((await tail.read()).length).toBeGreaterThan(0);
    expect(await tail.read()).toEqual([]);
    expect(await tail.read()).toEqual([]);
  });
});

describe("LineBuffer", () => {
  test("keeps the newest and drops the oldest", () => {
    const buffer = new LineBuffer(3);
    buffer.push(["a", "b", "c", "d"]);
    expect(buffer.render()).toBe("b\nc\nd");
    expect(buffer.size).toBe(3);
  });

  test("pushing nothing changes nothing", () => {
    const buffer = new LineBuffer(3);
    buffer.push([]);
    expect(buffer.size).toBe(0);
  });
});

describe("TranscriptSession", () => {
  test("nothing to attach to", async () => {
    const session = new TranscriptSession(PROJECT, { root });
    expect(await session.attach()).toBe(false);
    expect(await session.poll()).toBeNull();
  });

  test("a first attach does not replay what was already written", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT, [
      assistantEntry([{ type: "text", text: "ancient history" }]),
    ]);
    age(path, 1);

    const session = new TranscriptSession(PROJECT, { root });
    expect(await session.attach()).toBe(true);
    expect(await session.poll()).toBeNull();

    appendEntry(path, assistantEntry([{ type: "text", text: "happening now" }]));
    const block = await session.poll();
    expect(block).toContain("happening now");
    expect(block).not.toContain("ancient history");
  });

  test("the block carries reasoning, the call and the result", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 1);
    const session = new TranscriptSession(PROJECT, { root });
    await session.attach();

    appendEntry(path, assistantEntry([{ type: "thinking", thinking: "look at the file" }]));
    appendEntry(path, assistantEntry([
      { type: "tool_use", name: "Read", input: { file_path: "/a/b/status.ts" } },
    ]));
    appendEntry(path, { type: "user", cwd: PROJECT, message: { content: [{ type: "tool_result", content: "42 lines" }] } });

    const block = (await session.poll())!;
    expect(block.split("\n")).toEqual([
      "🧠 look at the file",
      "● Read: status.ts",
      "  └ 42 lines",
    ]);
  });

  test("tokens accumulate into a header the scraper can read", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 1);
    const session = new TranscriptSession(PROJECT, { root });
    await session.attach();

    appendEntry(path, assistantEntry([{ type: "text", text: "one" }], { output_tokens: 2_000 }));
    appendEntry(path, assistantEntry([{ type: "text", text: "two" }], { output_tokens: 1_900 }));

    const block = (await session.poll())!;
    expect(block.split("\n")[0]).toBe("⏳ ↓ 3.9k tokens");
  });

  test("an unchanged block is not re-emitted", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 1);
    const session = new TranscriptSession(PROJECT, { root });
    await session.attach();

    appendEntry(path, assistantEntry([{ type: "text", text: "only line" }]));
    expect(await session.poll()).toContain("only line");
    expect(await session.poll()).toBeNull();
  });

  test("entries that say nothing produce no block at all", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 1);
    const session = new TranscriptSession(PROJECT, { root });
    await session.attach();

    appendEntry(path, { type: "attachment", cwd: PROJECT });
    appendEntry(path, { type: "queue-operation", cwd: PROJECT });
    appendFileSync(path, "definitely not json\n");

    expect(await session.poll()).toBeNull();
  });

  test("the buffer is bounded, so a fan-out cannot grow it without limit", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 1);
    const session = new TranscriptSession(PROJECT, { root, bufferLines: 5 });
    await session.attach();

    for (let i = 0; i < 50; i++) {
      appendEntry(path, { type: "assistant", cwd: PROJECT, isSidechain: true, message: { content: [{ type: "text", text: `line ${i}` }] } });
    }

    const block = (await session.poll())!;
    expect(block.split("\n")).toHaveLength(5);
    expect(block).toContain("line 49");
    expect(block).toContain("│");
  });

  test("reading from the start, when asked", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT, [
      assistantEntry([{ type: "text", text: "written before we attached" }]),
    ]);
    age(path, 1);

    const session = new TranscriptSession(PROJECT, { root, fromStart: true });
    await session.attach();
    expect(await session.poll()).toContain("written before we attached");
  });

  /**
   * Raised in review of PR #61: `reresolve` swapped the file and kept the
   * counters, so a new session opened with the previous one's token total and
   * the previous one's last lines still on screen.
   */
  test("following the session to a new transcript leaves the old one behind", async () => {
    const first = writeTranscript("slug", "first.jsonl", PROJECT);
    age(first, 60);
    const session = new TranscriptSession(PROJECT, { root, bufferLines: 20 });
    await session.attach();

    appendEntry(first, assistantEntry([{ type: "text", text: "old session line" }], { output_tokens: 5_000 }));
    const before = (await session.poll())!;
    expect(before).toContain("old session line");
    expect(before).toContain("5.0k tokens");

    // A newer transcript for the same project, and enough quiet polls for the
    // monitor to go looking for one.
    const second = writeTranscript("slug", "second.jsonl", PROJECT, [
      assistantEntry([{ type: "text", text: "new session line" }], { output_tokens: 100 }),
    ]);
    age(second, 1);
    // The append above made `first` the newest file on disk. Resolution picks
    // by mtime, so the fixture has to put the two in the order a real handover
    // would: the finished session stops being written to.
    age(first, 60);
    for (let i = 0; i < RERESOLVE_AFTER_EMPTY_POLLS; i++) await session.poll();

    expect(session.path).toBe(second);

    const after = (await session.poll())!;
    expect(after).toContain("new session line");
    expect(after).not.toContain("old session line");
    expect(after).toContain("100 tokens");
    expect(after).not.toContain("5.1k tokens");
  });

  test("the resolved path is the one it reads", async () => {
    const path = writeTranscript("slug", "a.jsonl", PROJECT);
    age(path, 1);
    const session = new TranscriptSession(PROJECT, { root });
    expect(session.path).toBeNull();
    await session.attach();
    expect(session.path).toBe(path);
  });
});

/**
 * What the fold dropped, kept.
 *
 * Claude Code does not destroy the context it compacts. The transcript under
 * `~/.claude/projects/<slug>/<uuid>.jsonl` only grows, and at the fold it writes
 * a `compact_boundary` record naming exactly what left the model's head:
 * everything before `preservedSegment.headUuid`, by uuid rather than by an
 * approximate byte count. Until flow 059 nothing in this repository read it —
 * `channel/status.ts` tails that file every two seconds and walked straight past
 * the one line in it that says what was forgotten.
 *
 * Two halves, and they are separated on purpose. `utils/transcript-monitor.ts`
 * reads files and now says "there was a fold"; `channel/status.ts` decides what
 * that is worth, which is a disk read and an embedding call. Each half is
 * exercised here on its own, and then the expensive one is exercised twice to
 * prove it only pays once.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptSession } from "../../utils/transcript-monitor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeMemoryDeps, type FakeMemoryDeps } from "../fixtures/fake-memory-deps.ts";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import type { CompactBoundary } from "../../utils/context-usage.ts";
import type { StatusContext, StatusManager as StatusManagerType } from "../../channel/status.ts";

const PROJECT = "/home/someone/bots/helyx";
const SESSION_ID = 7;

/** The record as observed, trimmed to the fields that are read. */
function boundaryEntry(headUuid: string, tailUuid: string): unknown {
  return {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    cwd: PROJECT,
    compactMetadata: {
      trigger: "auto",
      preTokens: 999841,
      postTokens: 13608,
      cumulativeDroppedTokens: 986233,
      durationMs: 119544,
      preservedSegment: { headUuid, anchorUuid: "1f5d0eba", tailUuid },
    },
  };
}

const entry = (uuid: string, note: string) =>
  ({ type: "assistant", uuid, cwd: PROJECT, message: { content: note } });

let root: string;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helyx-fold-"));
  mkdirSync(join(root, "projects", "slug"), { recursive: true });
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  rmSync(root, { recursive: true, force: true });
});

/** A transcript under a `~/.claude`-shaped root, declaring its cwd. */
function writeTranscript(entries: unknown[]): string {
  const path = join(root, "projects", "slug", "session.jsonl");
  const lines = [{ type: "system", cwd: PROJECT }, ...entries].map((e) => JSON.stringify(e));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("the monitor notices the fold in lines it already reads", () => {
  test("a boundary in the poll's lines reaches the callback, with the file it was in", async () => {
    const path = writeTranscript([
      entry("a", "work before the fold"),
      boundaryEntry("head", "tail"),
      entry("head", "kept"),
    ]);
    const seen: Array<{ boundary: CompactBoundary; path: string }> = [];
    const session = new TranscriptSession(PROJECT, {
      root,
      fromStart: true,
      onCompactBoundary: (boundary, transcriptPath) => seen.push({ boundary, path: transcriptPath }),
    });

    await session.poll();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.boundary.headUuid).toBe("head");
    expect(seen[0]!.boundary.durationMs).toBe(119544);
    // The path matters as much as the boundary: the span is read back out of
    // this file, and the monitor is the only thing that knows which one it is.
    expect(seen[0]!.path).toBe(path);
  });

  test("an ordinary turn says nothing", async () => {
    writeTranscript([entry("a", "just working")]);
    let calls = 0;
    const session = new TranscriptSession(PROJECT, {
      root,
      fromStart: true,
      onCompactBoundary: () => { calls++; },
    });

    await session.poll();

    expect(calls).toBe(0);
  });

  test("a callback that throws does not cost the poll its lines", async () => {
    // The tail's read position has already moved by the time the callback runs.
    // An exception escaping here would lose the very lines the operator is
    // watching for.
    writeTranscript([
      boundaryEntry("head", "tail"),
      { type: "assistant", uuid: "head", cwd: PROJECT, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "file.ts" } }] } },
    ]);
    const session = new TranscriptSession(PROJECT, {
      root,
      fromStart: true,
      onCompactBoundary: () => { throw new Error("postgres is gone"); },
    });

    const block = await session.poll();

    expect(block).not.toBeNull();
  });
});

/** A StatusManager whose memory writes and Telegram calls are recorded. */
async function manager(db: FakeSql): Promise<{ status: StatusManagerType; deps: FakeMemoryDeps }> {
  const { restore: restoreTelegram } = await installFakeTelegram();
  cleanups.push(restoreTelegram);
  const { deps, restore: restoreMemory } = await installFakeMemoryDeps({ sql: db.sql });
  cleanups.push(restoreMemory);

  const { StatusManager } = await import("../../channel/status.ts");
  const status = new StatusManager({
    sql: db.sql as unknown as StatusContext["sql"],
    sessionId: () => SESSION_ID,
    sessionName: () => "helyx",
    projectName: "helyx",
    projectPath: PROJECT,
    token: () => "fake-token",
  });
  return { status, deps };
}

describe("the capture", () => {
  test("the dropped span goes to long-term memory with its project, session and the fold's numbers", async () => {
    const path = writeTranscript([
      entry("a", "the thing the session decided"),
      entry("b", "and the tool call it decided it from"),
      entry("head", "the first record the fold kept"),
    ]);
    const db = new FakeSql();
    const { status, deps } = await manager(db);

    await status.captureFold(
      {
        trigger: "auto",
        preTokens: 999841,
        postTokens: 13608,
        droppedTokens: 986233,
        cumulativeDroppedTokens: 986233,
        durationMs: 119544,
        headUuid: "head",
        tailUuid: "tail",
      },
      path,
    );

    expect(deps.remembered).toHaveLength(1);
    const stored = deps.remembered[0]!;
    expect(stored.type).toBe("transcript");
    expect(stored.projectPath).toBe(PROJECT);
    expect(stored.sessionId).toBe(SESSION_ID);
    // Raw, not summarised. A summary of what was lost is a second and lossier
    // artefact; the span itself cannot be recovered later.
    expect(String(stored.content)).toContain("the thing the session decided");
    expect(String(stored.content)).toContain("and the tool call it decided it from");
    // The head survived the fold, so it is not part of what was lost.
    expect(String(stored.content)).not.toContain("the first record the fold kept");
    // The boundary's own numbers have nowhere else to live.
    const tags = stored.tags as string[];
    expect(tags).toContain("compact-boundary");
    expect(tags).toContain("trigger:auto");
    expect(tags).toContain("dropped-tokens:986233");
    expect(tags).toContain("duration-ms:119544");
    expect(tags).toContain("tail:tail");
  });

  test("a truncated span says so in the content, not only in a tag", async () => {
    // Whoever reads the span back may never see the tags. A cut span filed as a
    // whole one is a lie told to the session trying to remember what happened.
    const filler = "x".repeat(200_000);
    const path = writeTranscript([
      ...Array.from({ length: 20 }, (_, i) => entry(`u${i}`, `${i}-${filler}`)),
      entry("head", "kept"),
    ]);
    const db = new FakeSql();
    const { status, deps } = await manager(db);

    await status.captureFold(foldOf("head", "tail"), path);

    expect(String(deps.remembered[0]!.content)).toContain("TRUNCATED");
    expect(deps.remembered[0]!.tags as string[]).toContain("truncated");
  });

  test("a fold that dropped nothing is not an embedding call", async () => {
    const path = writeTranscript([entry("tail1", "the first boundary"), entry("head2", "kept")]);
    const db = new FakeSql();
    const { status, deps } = await manager(db);

    await status.captureFold(foldOf("tail1", "tail1"), path);
    const afterFirstFold = deps.remembered.length;
    // The second fold starts where the first one ended, and there is nothing
    // between the two. An empty span is not worth an embedding call.
    await status.captureFold(foldOf("head2", "tail2"), path);

    expect(deps.remembered).toHaveLength(afterFirstFold);
  });

  test("a boundary without the uuids to place it is not guessed at", async () => {
    const path = writeTranscript([entry("a", "work"), entry("head", "kept")]);
    const db = new FakeSql();
    const { status, deps } = await manager(db);

    await status.captureFold({ ...foldOf("head", "tail"), headUuid: null }, path);
    await status.captureFold({ ...foldOf("head", "tail"), tailUuid: null }, path);

    expect(deps.remembered).toHaveLength(0);
  });

  test("the fold marker is closed even when the span cannot be read", async () => {
    // The marker suppresses the hung-session alarm. Left open because a file
    // read failed, it would suppress it until its grace window expired.
    const db = new FakeSql();
    const { status } = await manager(db);

    await status.captureFold(foldOf("head", "tail"), join(root, "gone.jsonl"));

    const [update] = db.matching("UPDATE sessions SET metadata");
    expect(update).toBeDefined();
    expect(update!.values).toEqual([119544, SESSION_ID]);
  });
});

describe("the same fold is captured once", () => {
  test("a boundary delivered twice is embedded once", async () => {
    // `tailUuid` names the boundary record itself, which is what makes it the
    // key. Without one, a poll that re-read the boundary would push the same two
    // megabytes through an embedding call again.
    const path = writeTranscript([entry("a", "work"), entry("head", "kept")]);
    const db = new FakeSql();
    const { status, deps } = await manager(db);

    await status.captureFold(foldOf("head", "tail"), path);
    await status.captureFold(foldOf("head", "tail"), path);
    await status.captureFold(foldOf("head", "tail"), path);

    expect(deps.remembered).toHaveLength(1);
  });

  test("however many times the transcript is re-read from the top", async () => {
    // What a re-read looks like from the capture's side: `reresolve` starts a new
    // file at offset zero, and a fixture read `fromStart` does the same.
    writeTranscript([
      entry("a", "work before the fold"),
      boundaryEntry("head", "tail"),
      entry("head", "kept"),
    ]);
    const db = new FakeSql();
    const { status, deps } = await manager(db);
    const captures: Promise<void>[] = [];
    const onCompactBoundary = (boundary: CompactBoundary, transcriptPath: string) => {
      captures.push(status.captureFold(boundary, transcriptPath));
    };

    for (let i = 0; i < 3; i++) {
      await new TranscriptSession(PROJECT, { root, fromStart: true, onCompactBoundary }).poll();
    }
    await Promise.all(captures);

    expect(captures).toHaveLength(3);
    expect(deps.remembered).toHaveLength(1);
  });

  test("a different fold in the same file is a different fold", async () => {
    const path = writeTranscript([
      entry("a", "dropped by the first fold"),
      entry("tail1", "the first boundary"),
      entry("b", "dropped by the second"),
      entry("head2", "kept"),
    ]);
    const db = new FakeSql();
    const { status, deps } = await manager(db);

    await status.captureFold(foldOf("tail1", "tail1"), path);
    await status.captureFold(foldOf("head2", "tail2"), path);

    expect(deps.remembered).toHaveLength(2);
    // The second span starts after the first boundary rather than at the top of
    // the file: that material has already been stored once.
    const second = String(deps.remembered[1]!.content);
    expect(second).toContain("dropped by the second");
    expect(second).not.toContain("dropped by the first fold");
  });
});

/** The observed boundary, with the two uuids a test cares about. */
function foldOf(headUuid: string, tailUuid: string): CompactBoundary {
  return {
    trigger: "auto",
    preTokens: 999841,
    postTokens: 13608,
    droppedTokens: 986233,
    cumulativeDroppedTokens: 986233,
    durationMs: 119544,
    headUuid,
    tailUuid,
  };
}

/**
 * Reading the one thing Claude Code tells us about a fold.
 *
 * Flow 054 was built on the belief that a fold destroys the conversation and
 * has to be raced. It does not: the transcript only grows, and at the fold
 * Claude Code writes a `compact_boundary` record naming exactly what it dropped.
 * Everything here is about reading that record without trusting it — the format
 * belongs to another program, and this repository has been bitten before by
 * treating someone else's output as a contract.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCompactBoundary, compactBoundaries } from "../../utils/context-usage.ts";
import { droppedSpan, DROPPED_SPAN_BUDGET_BYTES } from "../../utils/transcript-locate.ts";

/** The record as it actually appears, trimmed to the fields that are read. */
const REAL_BOUNDARY = {
  parentUuid: null,
  logicalParentUuid: "58aac518-e308-48dd-8d41-39090567885b",
  isSidechain: false,
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  level: "info",
  compactMetadata: {
    trigger: "auto",
    preTokens: 999841,
    postTokens: 13608,
    cumulativeDroppedTokens: 986233,
    durationMs: 119544,
    preservedSegment: {
      headUuid: "82253cdb-eea0-4316-afa3-ac6f1e01cb27",
      anchorUuid: "1f5d0eba-8996-47a3-ae26-a2cdebefdc10",
      tailUuid: "58aac518-e308-48dd-8d41-39090567885b",
    },
  },
};

describe("parseCompactBoundary", () => {
  test("reads the record captured from this project's own transcript", () => {
    const b = parseCompactBoundary(REAL_BOUNDARY)!;
    expect(b.trigger).toBe("auto");
    expect(b.preTokens).toBe(999841);
    expect(b.postTokens).toBe(13608);
    expect(b.durationMs).toBe(119544);
    expect(b.headUuid).toBe("82253cdb-eea0-4316-afa3-ac6f1e01cb27");
    expect(b.tailUuid).toBe("58aac518-e308-48dd-8d41-39090567885b");
  });

  test("this fold's drop, not the session's running total", () => {
    // cumulativeDroppedTokens was 986233 on the first boundary and 1967705 on
    // the second — a total, not an event. The number a reader wants is the
    // difference, which pre and post give by construction.
    const b = parseCompactBoundary(REAL_BOUNDARY)!;
    expect(b.droppedTokens).toBe(999841 - 13608);
    expect(b.cumulativeDroppedTokens).toBe(986233);
  });

  test("a session talking about compaction is not a fold", () => {
    // This repository discusses compaction constantly, so assistant entries are
    // full of the phrase. Matching on it would attribute a dropped span to a
    // boundary that never happened.
    expect(
      parseCompactBoundary({
        type: "assistant",
        message: { content: 'the log says "Conversation compacted" and subtype compact_boundary' },
      }),
    ).toBeNull();
    expect(parseCompactBoundary({ type: "system", subtype: "something_else" })).toBeNull();
    expect(parseCompactBoundary(null)).toBeNull();
    expect(parseCompactBoundary("compact_boundary")).toBeNull();
  });

  test("a boundary from a future CLI version is still a boundary", () => {
    // The format is not ours. A release that stops reporting durationMs has not
    // stopped folding, and a partly readable boundary is still worth acting on.
    const b = parseCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preservedSegment: { headUuid: "h" } },
    })!;
    expect(b).not.toBeNull();
    expect(b.headUuid).toBe("h");
    expect(b.durationMs).toBeNull();
    expect(b.trigger).toBeNull();
    expect(b.droppedTokens).toBeNull();
  });

  test("metadata missing entirely does not throw", () => {
    const b = parseCompactBoundary({ type: "system", subtype: "compact_boundary" })!;
    expect(b.headUuid).toBeNull();
    expect(b.preTokens).toBeNull();
  });

  test("a token count that is not a number is not a token count", () => {
    const b = parseCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: "999841", durationMs: Number.NaN, preservedSegment: {} },
    })!;
    expect(b.preTokens).toBeNull();
    expect(b.durationMs).toBeNull();
  });
});

describe("compactBoundaries", () => {
  test("both folds of a long session, oldest first", () => {
    const second = {
      ...REAL_BOUNDARY,
      compactMetadata: {
        ...REAL_BOUNDARY.compactMetadata,
        preTokens: 1003034,
        postTokens: 21562,
        preservedSegment: { headUuid: "b0bca396", anchorUuid: "5b414022", tailUuid: "7f21ba7a" },
      },
    };
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: "work" } }),
      JSON.stringify(REAL_BOUNDARY),
      JSON.stringify({ type: "user", message: { content: "more" } }),
      JSON.stringify(second),
    ];
    const found = compactBoundaries(lines);
    expect(found).toHaveLength(2);
    expect(found[0]!.headUuid).toBe("82253cdb-eea0-4316-afa3-ac6f1e01cb27");
    expect(found[1]!.headUuid).toBe("b0bca396");
  });

  test("a half-written final line does not lose the boundary before it", () => {
    const lines = [JSON.stringify(REAL_BOUNDARY), '{"type":"assistant","message":{"cont'];
    expect(compactBoundaries(lines)).toHaveLength(1);
  });
});

describe("droppedSpan", () => {
  let dir: string;
  let path: string;

  const entry = (uuid: string, note: string) =>
    JSON.stringify({ type: "assistant", uuid, message: { content: note } });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "span-"));
    path = join(dir, "t.jsonl");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("everything before the surviving head, from the top of the file", async () => {
    writeFileSync(
      path,
      [entry("a", "one"), entry("b", "two"), entry("head", "kept"), entry("d", "after")].join("\n") + "\n",
    );
    const span = (await droppedSpan(path, "head", null))!;
    expect(span.records).toBe(2);
    expect(span.text).toContain("one");
    expect(span.text).toContain("two");
    // The head survived the fold, so it is not part of what was lost.
    expect(span.text).not.toContain("kept");
    expect(span.text).not.toContain("after");
    expect(span.truncated).toBe(false);
  });

  test("a second fold starts after the first boundary, not at the top", async () => {
    writeFileSync(
      path,
      [
        entry("old", "belongs to the first fold"),
        entry("tail1", "the first boundary"),
        entry("x", "dropped by the second fold"),
        entry("head2", "kept"),
      ].join("\n") + "\n",
    );
    const span = (await droppedSpan(path, "head2", "tail1"))!;
    expect(span.records).toBe(1);
    expect(span.text).toContain("dropped by the second fold");
    expect(span.text).not.toContain("belongs to the first fold");
    expect(span.text).not.toContain("the first boundary");
  });

  test("a head that is not in the file is not guessed at", async () => {
    writeFileSync(path, entry("a", "one") + "\n");
    expect(await droppedSpan(path, "missing", null)).toBeNull();
  });

  test("a uuid quoted inside another record does not match it", async () => {
    // The substring pre-filter is a speed trick, not the test: the record whose
    // *own* uuid it is must be the one that matches.
    writeFileSync(
      path,
      [entry("a", "mentions head in passing"), entry("head", "kept")].join("\n") + "\n",
    );
    const span = (await droppedSpan(path, "head", null))!;
    expect(span.records).toBe(1);
    expect(span.text).toContain("mentions head in passing");
  });

  test("an oversized span is cut, and says so, keeping what is nearest the fold", async () => {
    const filler = "x".repeat(200_000);
    const many = Array.from({ length: 20 }, (_, i) => entry(`u${i}`, `${i}-${filler}`));
    writeFileSync(path, [...many, entry("head", "kept")].join("\n") + "\n");

    const span = (await droppedSpan(path, "head", null))!;
    expect(span.records).toBe(20);
    expect(span.truncated).toBe(true);
    expect(Buffer.byteLength(span.text, "utf8")).toBeLessThanOrEqual(DROPPED_SPAN_BUDGET_BYTES);
    // The newest records are the ones nearest the fold, so they are the ones kept.
    // Matched on the uuid rather than the payload: "10-" contains "0-".
    expect(span.text).toContain('"u19"');
    expect(span.text).not.toContain('"u0"');
  });

  test("a fold that dropped nothing is an empty span, not a failure", async () => {
    writeFileSync(path, [entry("tail1", "boundary"), entry("head", "kept")].join("\n") + "\n");
    const span = (await droppedSpan(path, "head", "tail1"))!;
    expect(span.records).toBe(0);
    expect(span.text).toBe("");
  });

  test("a file that is not there is null, not a throw", async () => {
    expect(await droppedSpan(join(dir, "nope.jsonl"), "head", null)).toBeNull();
  });
});

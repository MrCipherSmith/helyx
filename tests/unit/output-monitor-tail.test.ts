/**
 * Regression test for F-002: `tailFile` used to `Bun.file(filePath).text()`
 * the entire captured-output file on every 2-second poll, a cost that scaled
 * with everything the session had ever printed instead of the ~40 lines
 * actually needed. Fixed by tracking a byte offset per path and reading only
 * the bytes appended since the previous call — mirroring `TranscriptTail`
 * (utils/transcript-locate.ts). These tests assert the offset only ever
 * advances by what was actually appended (never rewinds to 0 on a plain
 * growth) and that a shrunk/replaced file forces a fresh reseed.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailFile, _tailOffsetForTest, _resetTailStateForTest } from "../../utils/output-monitor.ts";

let dir: string;

function makePath(name: string): string {
  dir = dir ?? mkdtempSync(join(tmpdir(), "output-monitor-test-"));
  return join(dir, name);
}

afterEach(() => {
  _resetTailStateForTest();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("tailFile", () => {
  test("returns the last N lines of a freshly seen file", async () => {
    const path = makePath("a.log");
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    writeFileSync(path, lines.join("\n") + "\n");

    const out = await tailFile(path, 3);

    // The file ends with a trailing newline, so split("\n") yields a
    // trailing empty element — the same shape the real captured-output
    // files have.
    expect(out.split("\n")).toEqual(["line 8", "line 9", ""]);
  });

  test("advances the offset to the file size after a read, not back to 0", async () => {
    const path = makePath("b.log");
    writeFileSync(path, "one\ntwo\nthree\n");

    await tailFile(path, 40);

    expect(_tailOffsetForTest(path)).toBe(Buffer.byteLength("one\ntwo\nthree\n"));
  });

  test("a second poll after growth reads only the appended bytes, and offset tracks the new size", async () => {
    const path = makePath("c.log");
    writeFileSync(path, "one\ntwo\n");
    await tailFile(path, 40);
    const offsetAfterFirst = _tailOffsetForTest(path);

    appendFileSync(path, "three\nfour\n");
    const out = await tailFile(path, 40);
    const offsetAfterSecond = _tailOffsetForTest(path);

    // The whole accumulated tail is still visible in the returned lines...
    expect(out.split("\n")).toEqual(["one", "two", "three", "four", ""]);
    // ...but the offset moved forward by exactly what was appended, proving
    // the second read did not restart from byte 0.
    expect(offsetAfterSecond).toBe((offsetAfterFirst ?? 0) + Buffer.byteLength("three\nfour\n"));
  });

  test("an unchanged file between polls does not move the offset", async () => {
    const path = makePath("d.log");
    writeFileSync(path, "steady\n");
    await tailFile(path, 40);
    const first = _tailOffsetForTest(path);

    await tailFile(path, 40);
    const second = _tailOffsetForTest(path);

    expect(second).toBe(first);
  });

  test("a truncated/replaced file (offset now past EOF) reseeds instead of erroring or returning stale content", async () => {
    const path = makePath("e.log");
    writeFileSync(path, "a".repeat(100) + "\nlast-of-old\n");
    await tailFile(path, 40);

    // Simulate log rotation: the file is replaced with something much smaller.
    writeFileSync(path, "fresh-start\n");
    const out = await tailFile(path, 40);

    expect(out).toBe("fresh-start\n");
    expect(out).not.toContain("last-of-old");
    expect(_tailOffsetForTest(path)).toBe(Buffer.byteLength("fresh-start\n"));
  });

  test("a missing file returns empty rather than throwing", async () => {
    const path = makePath("does-not-exist.log");
    const out = await tailFile(path, 40);
    expect(out).toBe("");
  });
});

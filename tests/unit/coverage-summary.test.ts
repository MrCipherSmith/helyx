/**
 * The bridge the whole quality reading rests on.
 *
 * `keryx health` imports coverage from `coverage/coverage-summary.json` in
 * Istanbul's shape, and Bun's test runner emits only `text` or `lcov`.
 * `scripts/coverage-summary.ts` converts one into the other, and until now the
 * number it produced was believed because it looked plausible.
 *
 * The arithmetic that matters is the total: found and hit summed across files,
 * never per-file percentages averaged. Averaging would let a fully covered
 * three-line file cancel out a thousand uncovered ones, and the gate would read
 * green while the codebase was not.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run the real script against a real lcov file and read back what it wrote. */
async function summarize(lcov: string): Promise<Record<string, { lines: { total: number; covered: number; pct: number } }>> {
  const dir = mkdtempSync(join(tmpdir(), "helyx-cov-"));
  dirs.push(dir);
  writeFileSync(join(dir, "lcov.info"), lcov);

  const proc = Bun.spawn(["bun", "scripts/coverage-summary.ts", dir], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  return JSON.parse(readFileSync(join(dir, "coverage-summary.json"), "utf-8"));
}

/** One lcov record: DA:<line>,<hits> per instrumented line. */
const record = (file: string, hits: number[]) =>
  [`SF:${file}`, ...hits.map((h, i) => `DA:${i + 1},${h}`), "end_of_record"].join("\n");

describe("lcov to an Istanbul summary", () => {
  test("the total sums lines, it does not average files", async () => {
    // The defect this guards: a three-line file at 100% and a hundred-line file
    // at 1% average to 50.5%, while the truth is 3.9%.
    const summary = await summarize(
      [
        record("small.ts", [1, 1, 1]),
        record("big.ts", [1, ...Array(99).fill(0)]),
      ].join("\n"),
    );

    expect(summary["small.ts"]!.lines).toEqual({ total: 3, covered: 3, pct: 100 });
    expect(summary["big.ts"]!.lines).toEqual({ total: 100, covered: 1, pct: 1 });
    expect(summary.total!.lines).toEqual({ total: 103, covered: 4, pct: 3.88 });
  });

  test("a file with no instrumented lines does not drag the total", async () => {
    // It contributes nothing to either side of the fraction — which is right:
    // a file with nothing to cover is neither covered nor uncovered.
    const summary = await summarize([record("empty.ts", []), record("real.ts", [1, 0])].join("\n"));

    expect(summary["empty.ts"]!.lines).toEqual({ total: 0, covered: 0, pct: 100 });
    expect(summary.total!.lines).toEqual({ total: 2, covered: 1, pct: 50 });
  });

  test("a record left unterminated by a truncated file is still counted", async () => {
    // Bun has been caught mid-write before; losing the last file silently would
    // change the number without changing anything visible.
    const lcov = `${record("a.ts", [1, 1])}\nSF:b.ts\nDA:1,0\nDA:2,1\n`;

    const summary = await summarize(lcov);

    expect(summary["b.ts"]!.lines).toEqual({ total: 2, covered: 1, pct: 50 });
    expect(summary.total!.lines.total).toBe(4);
  });

  test("a path that appears twice keeps the last record rather than doubling it", async () => {
    // Stated because it is a choice: the alternative is to merge, and a merged
    // count of the same file from two runs would exceed the file's own length.
    const summary = await summarize([record("a.ts", [1, 1]), record("a.ts", [0, 0, 0])].join("\n"));

    expect(summary["a.ts"]!.lines).toEqual({ total: 3, covered: 0, pct: 0 });
    expect(summary.total!.lines.total).toBe(3);
  });
});

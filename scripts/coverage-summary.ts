#!/usr/bin/env bun
/**
 * lcov.info → Istanbul-style coverage-summary.json.
 *
 * `keryx health` reads coverage from coverage/coverage-summary.json (Istanbul's
 * shape) and Bun's test runner only emits `text` or `lcov`. This bridges the
 * two so the coverage dimension stops reporting "missing".
 *
 * Only what health actually reads is produced: a `lines.pct` per file plus a
 * `total`. Nothing here pretends to be a full Istanbul report.
 *
 * Usage: bun scripts/coverage-summary.ts [coverage-dir]
 */

import { existsSync } from "fs";
import { join } from "path";

const coverageDir = process.argv[2] ?? "coverage";
const lcovPath = join(coverageDir, "lcov.info");
const outPath = join(coverageDir, "coverage-summary.json");

if (!existsSync(lcovPath)) {
  console.error(`No ${lcovPath}. Run: bun test --coverage --coverage-reporter=lcov`);
  process.exit(1);
}

type FileCoverage = { found: number; hit: number };

const files = new Map<string, FileCoverage>();
let current: string | null = null;
let found = 0;
let hit = 0;

const flush = (): void => {
  if (current === null) return;
  files.set(current, { found, hit });
  current = null;
  found = 0;
  hit = 0;
};

for (const raw of (await Bun.file(lcovPath).text()).split("\n")) {
  const line = raw.trim();
  if (line.startsWith("SF:")) {
    flush();
    current = line.slice(3);
  } else if (line.startsWith("DA:")) {
    // DA:<line>,<hits> — counted directly, because Bun does not always emit
    // the LF/LH totals that would otherwise carry this.
    const [, hits] = line.slice(3).split(",");
    found += 1;
    if (Number(hits) > 0) hit += 1;
  } else if (line === "end_of_record") {
    flush();
  }
}
flush();

const pct = (c: FileCoverage): number =>
  c.found === 0 ? 100 : Math.round((c.hit / c.found) * 10000) / 100;

const summary: Record<string, { lines: { total: number; covered: number; pct: number } }> = {};
let totalFound = 0;
let totalHit = 0;

for (const [file, c] of files) {
  summary[file] = { lines: { total: c.found, covered: c.hit, pct: pct(c) } };
  totalFound += c.found;
  totalHit += c.hit;
}

const total: FileCoverage = { found: totalFound, hit: totalHit };
summary.total = { lines: { total: totalFound, covered: totalHit, pct: pct(total) } };

await Bun.write(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${outPath}: ${files.size} files, lines ${pct(total)}%`);

/**
 * CLI wrapper for Claude's independent code review.
 *
 * Usage:  bun scripts/review.ts "<review request>"
 *
 * Runs every enabled reviewer (see `services/reviewer-service.ts`) in parallel
 * and prints their reports. When no reviewer is available it prints the single
 * line `SELF` — CLAUDE.md turns that into Claude reviewing the change itself.
 *
 * Every run also leaves an artifact under `logs/reviews/`. That is a by-product
 * and is treated as one: it is written after the reports have been printed, a
 * failure to write it warns on stderr and changes neither stdout nor the exit
 * code, and the `SELF` contract in particular must never become conditional on
 * a writable disk.
 *
 * Never echoes the provider token: reviewers authenticate through the
 * `providers` table, not through arguments.
 */

import { runReviewers, gitReviewDiff, reviewConsoleLines } from "../services/reviewer-service.ts";
import {
  persistReviewRun,
  pruneReviewArtifacts,
  type GitContext,
} from "../services/review-artifacts.ts";

const prompt = process.argv[2]?.trim() || "Review the latest changes on the current branch.";

/** One git fact, or "" — a review must not fail because a question about the repo did. */
async function git(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? out.trim() : "";
  } catch {
    return "";
  }
}

async function gitContext(diffBytes: number): Promise<GitContext> {
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])) || "detached";
  const head = await git(["rev-parse", "HEAD"]);
  let mergeBase = "";
  for (const trunk of ["origin/main", "main"]) {
    mergeBase = await git(["merge-base", "HEAD", trunk]);
    if (mergeBase) break;
  }
  return { branch, head, mergeBase, diffBytes };
}

const startedAt = Date.now();

// Read once and measured: the diff the reviewers are given is the one the
// record should say was sent.
const diff = await gitReviewDiff();
const result = await runReviewers(prompt, async () => diff);
const finishedAt = Date.now();

// `SELF` when every reviewer is down — the line CLAUDE.md turns into a
// self-review. The shaping lives in the service so a test can hold it still.
for (const line of reviewConsoleLines(result)) console.log(line);

const artifact = await persistReviewRun(result, {
  trigger: "manual",
  prompt,
  git: await gitContext(Buffer.byteLength(diff, "utf-8")),
  startedAt,
  finishedAt,
});

if (artifact) {
  await pruneReviewArtifacts();
  // Printed after the reports and after `SELF`, so a reader of either is
  // unaffected: CLAUDE.md matches the reports and the bare `SELF` line.
  console.error(`[review] artifact: ${artifact.dir}`);
} else {
  console.error("[review] could not write the run artifact; the review above is unaffected");
}

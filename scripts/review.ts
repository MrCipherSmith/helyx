/**
 * CLI wrapper for Claude's independent code review.
 *
 * Usage:  bun scripts/review.ts "<review request>"
 *
 * Runs every enabled reviewer (see `services/reviewer-service.ts`) in parallel
 * and prints their reports. When no reviewer is available it prints the single
 * line `SELF` — CLAUDE.md turns that into Claude reviewing the change itself.
 *
 * Never echoes the provider token: reviewers authenticate through the
 * `providers` table, not through arguments.
 */

import { runReviewers } from "../services/reviewer-service.ts";

const prompt = process.argv[2]?.trim() || "Review the latest changes on the current branch.";

const result = await runReviewers(prompt);

if (result.mode === "self") {
  // All reviewers are down (rate limit / balance / auth). The caller falls
  // back to its own review, so the only thing this must communicate is "self".
  console.log("SELF");
  process.exit(0);
}

for (const report of result.reports) {
  if (report.ok) {
    console.log(`\n===== ${report.label} (${report.model}) =====\n`);
    console.log(report.content);
  } else {
    console.log(`\n[${report.label} (${report.model})] unavailable: ${report.error}`);
  }
}

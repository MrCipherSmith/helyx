# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `renderRunJson` produces valid JSON carrying a format version, the trigger, the git context, the prompt, the mode and every report field that exists; proved by parsing it back in a test.
- AC2: A truncated answer is recorded as an explicit flag rather than left to be pattern-matched out of an error string; proved by test.
- AC3: `renderReportMd` carries a `Version` line, the branch, the trigger and each reviewer's label, model and content, and renders an unavailable reviewer as unavailable rather than omitting it; proved by test.
- AC4: `persistReviewRun` writes both files under a per-run directory and returns their paths; proved by test against a real temporary directory.
- AC5: `persistReviewRun` returns null instead of throwing when the directory cannot be written; proved by test.
- AC6: A run in which every reviewer failed still produces an artifact, recording `mode: "self"`; proved by test.
- AC7: `pruneReviewArtifacts` respects both an age limit and a count limit, and never removes the newest run of a branch; proved by test.
- AC8: `scripts/review.ts` still prints each report to stdout and the bare line `SELF` when every reviewer is down — the contract CLAUDE.md depends on; verified by reading the script and by a test over its output-shaping helper.
- AC9: A persistence failure changes neither the exit code nor stdout; proved by test.
- AC10: What `keryx memory ingest --from-review` does with a produced `report.md` is measured and written down. Measured: it exits 0 and creates one "lesson" per heading line — `trigger-manual`, `mode-external`, `diff-12345-bytes` — so the receiver accepts the file without the result being worth keeping. The criterion is met by recording that, not by treating the exit code as success; aligning the two formats belongs to whoever owns the ingester.
- AC11: Whole unit suite green and `tsc --noEmit` clean.
- AC12: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC13: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

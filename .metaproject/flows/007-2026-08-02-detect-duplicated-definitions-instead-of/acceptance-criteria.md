# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `scripts/find-duplicate-definitions.ts` exists and is runnable as `bun run dupes`, reporting each duplicated literal with every file it appears in.
- AC2: A regex literal appearing in two source files is reported; one appearing in a single file is not.
- AC3: Import paths, URLs and division expressions are not reported as regex literals — the two demonstrated false positives from the prototype (`/memory/summ`, `/api.telegram.org/`) are covered by a test.
- AC4: String constants are reported only above a stated length threshold, and the threshold is named in the script rather than being a bare number.
- AC5: Tests and fixtures are excluded by default and included with `--include-tests`, and a test covers both modes.
- AC6: The detector's own parsing is tested against synthetic sources, not against this repository, so the tests do not change meaning as the repository does.
- AC7: The script reports and exits 0 by default; a stated flag makes it exit non-zero, and neither is wired into CI in this flow.
- AC8: Running it on this repository is recorded in the flow journal, distinguishing real duplicates from acceptable ones.
- AC9: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC10: The script's header states what it cannot see — literals built by concatenation or templates, and paraphrased duplication — so it is not mistaken for a completeness guarantee.

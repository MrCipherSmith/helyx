# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `bun run health` regenerates coverage, runs a project-scope test report and then the gate, in that order; verified by running it end to end.
- AC2: After that command, the health artifact reports `tests: available` rather than `missing`; verified from the artifact.
- AC3: After that command, the coverage figure in the artifact is the one just measured, not an older import; verified by comparing the artifact against the summary file's own output.
- AC4: `scripts/coverage-summary.ts` has a test proving it sums found and hit across files rather than averaging per-file percentages, and that a file with no instrumented lines does not drag the total; proved by test.
- AC5: The test also covers what the script must not break on: an lcov record without `end_of_record`, and a path that appears twice.
- AC6: `docs/requirements/io-layer-coverage-2026-08-05` carries the exact lcov figures, labelled as exact, with the estimates removed and the correction stated.
- AC7: The ranking of target files in that package is re-derived from the exact figures, and any change of order is reflected in the plan.
- AC8: `.metaproject/memory/task-notes/coverage-programme-state.md` is superseded through `keryx memory supersede`, and the superseding note records that the fixture blocker is closed and what the measured position is.
- AC9: `keryx memory check` passes afterwards.
- AC10: Whole unit suite green and `tsc --noEmit` clean.
- AC11: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

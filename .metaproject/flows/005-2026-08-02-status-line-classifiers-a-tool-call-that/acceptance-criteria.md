# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/status-format.ts` exists and exports `parseTokenCount`, `formatElapsed`, `getSpinnerIcon`, `computeSignature` and `detectPhase`; `channel/status.ts` imports all five and defines none of them.
- AC2: A test reproduces each of the four demonstrated misclassifications and asserts the corrected phase: a bash command mentioning `waiting`, a file read of a path containing `permission`, a script named `approve-…`, and the control case.
- AC3: A real Claude Code permission prompt — the dialog text `tests/unit/tmux-watchdog.test.ts` already encodes — still classifies as `waiting`.
- AC4: `detectPhase` is tested for every phase it can return, plus null for empty and whitespace input.
- AC5: `getSpinnerIcon` takes `now` as a parameter, and tests cover the stale ⚠️, the boundary at exactly the stale threshold, and frame cycling past the end of the frame list.
- AC6: `parseTokenCount` is tested for plain, `k` and `M` suffixes, comma grouping, case-insensitivity, a missing unit, and a rejected input; the multi-dot behaviour is pinned as it is, with a comment naming it as a defect deferred to a separate decision.
- AC7: `computeSignature` is tested for determinism, for differing on differing input, and for handling an empty string and multi-byte text without throwing.
- AC8: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC9: `keryx health run` reports coverage strictly above the 17.72% recorded at flow start, with no new gate failure reason beyond the pre-existing coverage warning.
- AC10: The behaviour change is recorded in the PR: a tool call mentioning a permission word no longer raises the 💬 waiting signal.

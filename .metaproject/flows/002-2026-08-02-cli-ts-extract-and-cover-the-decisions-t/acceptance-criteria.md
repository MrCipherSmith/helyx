# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/cli-flags.ts` exports `parseFlags` and `flagValue`; `cli.ts` imports both and defines neither, and tests cover `--k=v`, `--k v`, a bare boolean flag, `--k=` treated as absent, a repeated flag, and a value that itself starts with `--`.
- AC2: `utils/host-memory.ts` exports `parseCgroupV2Max`, `parseCgroupV1Limit`, `parseMemTotal` and `presetsThatFit`; `cli.ts` uses all four and reimplements none.
- AC3: A test asserts `parseCgroupV1Limit` rejects the unlimited sentinel (a value at or above 1e15) and that `parseCgroupV2Max` rejects the literal `max`.
- AC4: A test asserts `presetsThatFit` returns every preset when memory is unknown (`null`) and only those at or below the limit otherwise, including the empty result when none fit.
- AC5: `utils/stop-hook.ts` exports `classifyCheckout` and `pruneStaleStopHooks`; `cli.ts` uses both, and the filesystem access in each is supplied by the caller rather than performed inside the module.
- AC6: `pruneStaleStopHooks` is tested for: removing a hook whose script is missing, keeping one whose script exists, keeping unrelated hooks, deleting an entry left with no hooks, returning the removed count, and mutating the array it is given in place.
- AC7: `classifyCheckout` is tested for a temp-dir checkout, a git worktree, a normal checkout, and a path that merely starts with the tmpdir name without being inside it.
- AC8: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC9: `helyx --help` and `helyx ps` are run after the rewire and behave as before; no CLI output, prompt or default changes anywhere in the diff.
- AC10: `keryx health run` reports coverage strictly above the 16.44% recorded at flow start, with no new gate failure reason beyond the pre-existing coverage warning.

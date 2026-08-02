# Flow Journal

- 2026-08-02T11:47:38.126Z - flow created
- 2026-08-02T11:49:18.670Z - frozen: 10 criteria; checksum recorded
- 2026-08-02T11:49:18.755Z - started
- 2026-08-02T11:49:18.847Z - task-done: T1: Collect remaining context
- 2026-08-02T11:52:50.767Z - task-done: T2: Implement per plan
- 2026-08-02T11:52:50.854Z - task-done: T3: Add/adjust tests and make them pass

## Codex review, 2026-08-02

Verdict: REQUEST CHANGES. Two findings, both accepted and fixed.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | major | `classifyCheckout` was given `gitPathIsFile` as an eagerly-evaluated boolean, so `statSync` now ran before the temporary-directory check. The code it replaced returned before touching `.git`. A `.git` that is missing or unreadable would throw where the original returned `"temporary directory"` cleanly — a regression introduced by the extraction itself. | **Fixed.** The probe is a thunk, called only after the temp rules miss. Three tests added: the probe is not called for a temp path, is called otherwise, and a throwing probe propagates only where it is reached. |
| 2 | minor | `availableMemoryMb`'s orchestration — source order and fallthrough — stayed in `cli.ts` and so remained untested; only the parsers moved. | **Fixed.** `resolveMemoryMb(read)` moved into `utils/host-memory.ts` with the source list beside it; `cli.ts` passes `readFileSync`. Eight tests cover the order (a container limit beating `/proc/meminfo`), fallthrough past a throwing source and past the v1 sentinel, the all-null case, and that later sources are not read once one answers. |

Finding 1 is the useful one: the flow's own AC5 asked for filesystem access to
be supplied by the caller, and doing that naively changed *when* the
filesystem is touched. The AC did not say "and not sooner"; the review caught
what the criterion did not.

After the fixes: 450 tests pass (from 439), tsc clean, eslint 0 errors,
`helyx --help` and `helyx ps` re-run and unchanged.

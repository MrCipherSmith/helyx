# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `bun run typecheck` exits 0 and `bun run lint` reports 0 errors.
- AC2: `bun test tests/unit/` passes, including a new test for the summarizer ceiling.
- AC3: The JSON summary's timeout and `num_predict` are named exported constants, not literals inside the fetch call, and the docstring records the measured cold load (17.2s) and slowest generation rate (9.3 tok/s).
- AC4: A test asserts the ceiling covers a cold load plus `num_predict` tokens at the slowest measured rate, so lowering it below what e4b needs fails the suite.
- AC5: A live run of the real JSON-summary payload against `geekom-model-1` returns parseable JSON with a `summary` string and a `facts` array, inside the new ceiling, from cold.
- AC6: `cli.ts` no longer suggests `qwen3:1.7b` as the commented-out `SUMMARIZE_MODEL` default — that model is not installed on the host.
- AC7: Nothing changes for a deployment that leaves `SUMMARIZE_MODEL` empty: the cloud fallback path is untouched.

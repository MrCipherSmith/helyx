# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `bun test tests/unit/` passes with `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, `GROQ_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` all blank and with `dashboard/dist` absent — the CI condition reproduced locally — and passes unchanged with the developer's real `.env` in place.
- AC2: `tests/preload.ts` sets every provider credential the voice chain reads, so no test outcome depends on what a machine's `.env` contains; the reason is stated in the file the way the existing token pins are.
- AC3: In the Russian `auto` chain, Piper is attempted before Yandex; Yandex is reached only when Piper returns nothing; Groq stays last. The docstring above `synthesize` and the inline comment both describe the order the code actually runs.
- AC4: `tests/unit/tts-chain.test.ts` asserts the new order directly: a test that fails if Yandex is tried first, and a test that proves Yandex is still reached when Piper fails.
- AC5: `tests/unit/dashboard-auth.test.ts` passes whether or not `dashboard/dist` was built, and removes only the file it created itself.
- AC6: `synthesizePiper` writes to a path unique per call rather than per millisecond, so two syntheses starting in the same millisecond cannot delete each other's audio; the CI log's `ENOENT` on a file the process had just written is accounted for by this.
- AC7: The `test` job of the Build workflow is green on the PR for this flow.

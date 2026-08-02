# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/status-format.ts` exports `resolvePhase(stage, awaitingPermission)`, which returns `waiting` whenever the latch is held and otherwise exactly what `detectPhase` returns for that stage.
- AC2: A test asserts the latch outranks every phase `detectPhase` can produce, including that it forces `waiting` for a stage that would otherwise classify as running, reading, writing, searching or thinking.
- AC3: A test asserts `resolvePhase` returns null for empty input only when the latch is not held — an empty stage while blocked still shows the signal.
- AC4: `StatusManager` holds the latch per chat, exposes `setAwaitingPermission`, and computes the phase through `resolvePhase` at the single site that previously called `detectPhase`.
- AC5: The latch counts concurrent holders rather than being a boolean, and a test asserts that two overlapping requests in one chat do not clear each other's signal — the second release is what ends it.
- AC6: `pollForResponse` sets the latch and releases it in a `finally`, so every exit — answered, resolved in the terminal, timed out, or thrown — releases it without any path being enumerated.
- AC7: The latch is only ever taken after a successful Telegram delivery: `pollForResponse` is called solely on the `sendResult.ok` path, and the send-failure branch returns before it.
- AC8: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC9: `keryx health run` reports coverage strictly above the 17.83% recorded at flow start, with no new gate failure reason beyond the pre-existing coverage warning.
- AC10: The PR states plainly that the lifecycle is verified by the scope construct and by inspection of every exit, not by an end-to-end test, and says why.

# Implementation Plan

Status: agreed

## Approach

The correctness question here is not "does the flag get set" but "does it
always get cleared". Flow 005's attempt failed on exactly that: it enumerated
some exit paths and missed the rest. `pollForResponse` has five ways out —
answered via Telegram, resolved in the terminal, timed out, an unexpected
throw, and the early return when delivery failed — and any list of them
written by hand is a list that can be incomplete.

So the latch is bound to a scope rather than to a set of paths:

```
setAwaitingPermission(chatId, true)
try { …the whole wait… } finally { setAwaitingPermission(chatId, false) }
```

`pollForResponse` is called only after `sendResult.ok`, so scoping it to that
method also gives "latched after successful delivery" for free, rather than as
another thing to remember.

Two pieces:

- `utils/status-format.ts` gains `resolvePhase(stage, awaitingPermission)` —
  pure, and the only place that knows the latch outranks the classifier.
  `StatusManager` calls it where it called `detectPhase`.
- `StatusManager` gains a per-chat flag and `setAwaitingPermission`. Nothing
  else in it changes: the stage keeps updating, so the operator still sees
  which tool is pending, and only the phase is forced.

Forcing the phase rather than freezing the stage is deliberate. While a prompt
is up Claude is blocked, so the pane is static and there is nothing to
suppress; and the stage text is the useful part — 💬 plus "Running: npm test"
says more than 💬 alone.

## Steps

1. `resolvePhase` in `utils/status-format.ts`, with tests.
2. The flag and `setAwaitingPermission` in `StatusManager`; call `resolvePhase`
   at the one site that computes the phase.
3. `pollForResponse` wrapped in try/finally.
4. `bun run typecheck`, `bun run lint`, `bun test tests/unit/`,
   `keryx health run`.
5. Read every exit of `pollForResponse` and confirm the finally covers it —
   and say plainly in the PR that the lifecycle is verified by inspection and
   the scope construct, not by an end-to-end test, because exercising it needs
   a live Telegram round trip.

## Risks

- **A leaked latch is the failure mode**, and it is silent: the status would
  show 💬 forever and the operator would stop trusting the signal. try/finally
  is the mitigation, chosen precisely because it does not depend on anyone
  enumerating paths correctly.
- **Concurrent requests in one chat.** Two prompts pending at once would have
  the second's finally clear the first's latch. Handled by counting rather
  than flagging, and tested.
- The status message is per chat and so is the flag; a forum topic maps to its
  own chat id, so two projects cannot collide.

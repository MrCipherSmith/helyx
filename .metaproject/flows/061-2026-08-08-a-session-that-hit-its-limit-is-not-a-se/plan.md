# Implementation Plan

Status: ready

## Approach

The same shape flow 059 established, and for the same reason: Claude Code
already says what happened, in a file that is already being read every two
seconds. Nothing new polls anything.

Parsing is pure and goes beside `parseCompactBoundary` in `utils/context-usage.ts`
— same input, a transcript entry; same output, a typed record or null; same
reason for the tests to exist without a disk.

The state has to be shared, because the two halves live in different processes:
the channel sees the transcript on the host, the supervisor alerts from inside
the container. `sessions.metadata` already carries the fold marker for exactly
this reason, and a limit marker sits beside it. Reusing that path also means
`checkHungSessions` learns about limits the same way it learned about folds —
one more reason to hold the alarm, written in the shape it already has.

The blind spot is the one piece that is not new machinery but a widened query.
`checkHungSessions` inner-joins the Telegram status table; a session with no row
is invisible. The fix is to stop requiring that row and to take the session's
own last activity as the fallback clock, so a pane-driven session becomes
visible without changing what "stale" means for the ones already covered.

## Steps

1. `parseApiError(entry)` in `utils/context-usage.ts` — returns
   `{ kind: "session-limit" | "weekly-limit" | "overloaded" | "prompt-too-long" | "network" | "other",
   resetsAt: string | null, text: string }` or null. Recognised by
   `isApiErrorMessage === true`, never by matching the prose alone: a session
   discussing limits writes those words constantly.
2. The reset time is parsed as written — `5:30pm (UTC)`, `2pm (UTC)` — into
   something comparable, and left null when it is absent or unparseable rather
   than guessed.
3. `channel/status.ts` recognises the error in the lines it already receives
   and writes a limit marker to `sessions.metadata` beside the fold marker,
   carrying kind and reset time.
4. The supervisor alerts once per limit event into its topic, saying which limit
   and when it lifts. Once, not once per loop — the same idempotency problem the
   fold capture solved with `tailUuid`.
5. `checkHungSessions` reads the limit marker and, where it holds, reports the
   session as limited rather than hung, with no restart button. The marker
   expires at the stated reset time, so an unlifted one cannot mute the alarm
   for ever.
6. The hung query stops requiring a row in `active_status_messages`: left join
   instead of inner, and staleness measured from the newest of the status row
   and the session's own last activity.

7. The pulse. Assembled where the numbers already are: the context-pressure
   loop reads each active session's transcript every two minutes and already
   computes tokens, window and ratio. It gains an output-token total and the
   turn's elapsed time, and the supervisor renders one line per working session.
   The interval is deliberately not the same as that loop's — a pulse every two
   minutes is noise; the reading is cheap and the posting is not.
8. "Working" is decided the same way the rest of this file decides it, and that
   definition is the one step 6 is fixing — so the pulse waits on step 6 rather
   than inheriting the blind spot.
9. A pulse identical to the previous one is the interesting case, not the boring
   one: the numbers moving is the proof that the session is thinking, so two
   readings the same is a third state beside hung and limited. It is reported as
   what it is — stopped progressing — and not as either of the other two.

## Risks

- **Widening the hung query is the dangerous step.** Every session becomes a
  candidate, including ones that were never covered and may be quiet for
  ordinary reasons. Done wrong, this replaces a blind spot with a stream of
  false alarms, which is worse: an alarm nobody believes is an alarm that is
  off. The fallback clock has to be a real activity signal, and this step wants
  a test per case rather than a general argument.
- The error texts are another program's wording and will change. Hence
  recognition by the flag and a bucket for `other`, so an unrecognised error is
  still reported as an error rather than dropped.
- A limit marker that outlives its reset would suppress hang detection exactly
  when the session is genuinely stuck. It expires on the stated time, and when
  the time is missing it expires on a bound.
- **The pulse is a message the operator has not asked for, arriving forever.**
  That is how a monitoring feature becomes noise and then becomes muted, taking
  the alarms next to it down with it. Hence: only working sessions, nothing sent
  when there is nothing to say, and an interval chosen against how long real
  work takes rather than against how often the data refreshes. If it cannot be
  made quiet, it is worth less than the silence it replaces.

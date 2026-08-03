# Flow Journal

- 2026-08-03T14:55:20.973Z - flow created
- 2026-08-03T15:02:57.594Z - task-added: T5: utils/ask-question.ts — parse, build, encode, format
- 2026-08-03T15:02:57.687Z - task-added: T6: services/ask-question.ts — resolve, register, wait, record
- 2026-08-03T15:02:57.779Z - task-added: T7: migration 47 — question_requests
- 2026-08-03T15:02:57.864Z - task-added: T8: endpoint /api/hooks/ask-question, blocking
- 2026-08-03T15:02:57.954Z - task-added: T9: callback handler for ask:
- 2026-08-03T15:02:58.041Z - task-added: T10: scripts/ask-question-hook.sh
- 2026-08-03T15:02:58.131Z - task-added: T11: supervisor: waiting on a question is not hung
- 2026-08-03T15:02:58.219Z - task-added: T12: cli.ts: register the PreToolUse hook
- 2026-08-03T15:02:58.308Z - task-added: T13: tests for all of the above
- 2026-08-03T15:02:58.398Z - task-added: T14: full gate
- 2026-08-03T15:02:58.488Z - frozen: 15 criteria; checksum recorded
- 2026-08-03T15:02:58.575Z - started

## What happened

### The order was wrong, and it is recorded rather than tidied away

The user asked for this to be implemented, and I spent the next stretch closing
review findings on an already-open PR instead. Those findings included a real
production bug, so the work was worth doing — but it was not what was asked
for, and the user had to ask twice more before any of this existed. The
priority call was mine and it was wrong.

The PRD here was also written after the code rather than before it, for the
same reason. Recorded as it happened.

### The probe that sent a message in the operator's name

The first design let the selector render and answered it with `tmux send-keys`,
the way terminal permission dialogs are answered. To find out which keys the
selector takes, I armed a probe: wait seven seconds, capture the pane, press
`1`. It fired before the question existed. The keystroke landed in the prompt
and `Enter` sent it as a message from the operator, interrupting the turn.

The defect was not the timing. It was writing something that acts on a timer
without first checking its precondition — the same class of defect this
programme has been finding in other people's code all week.

It also settled the design. A mechanism that types into a shared pane can, on a
misjudged moment, speak as the operator. Reading the hook contract instead of
guessing showed there was no need to: `PreToolUse` has a 600-second default
timeout, the same wait the permission flow already allows, so the hook can hold
the call open and collect the answer itself. Nothing here touches the pane.

### What the contract allows, and what it does not

A `PreToolUse` hook cannot hand back a synthetic tool result — only allow, deny
or edit the input. So an answer collected in Telegram comes back as a *refusal*
carrying the choice in its reason, which is text the model reads. Unusual to
look at, exact in effect.

And on timeout Claude Code proceeds as though the hook had not run. That is what
makes the whole thing safe to add: every failure path is silence, and silence is
the behaviour that exists today.

### Two things worth naming

Option index zero is an answer. A naive truthiness check would have waited
forever for anyone who chose the first option — and the first option is the one
marked "recommended".

The tool is one call with several questions. Denying after the first answer
would tell Claude the rest had been declined, so the refusal waits for all of
them.

### Numbers

Tests 801 → 844. `bun run dupes` still 1.

### Not verified end to end

The bot runs in Docker and this needs a rebuild to take effect; the hook also
has to be registered in the user's global settings by the setup wizard. Neither
was done, because both need the user's go-ahead. Everything below the
process boundary is tested; the wiring across it is not yet proven on a live
session.
- 2026-08-03T15:55:43.677Z - task-done: T1: Collect remaining context
- 2026-08-03T15:55:43.767Z - task-done: T2: Implement per plan
- 2026-08-03T15:55:43.856Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T15:55:43.944Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T15:55:44.030Z - task-done: T5: utils/ask-question.ts — parse, build, encode, format
- 2026-08-03T15:55:44.116Z - task-done: T6: services/ask-question.ts — resolve, register, wait, record
- 2026-08-03T15:55:44.202Z - task-done: T7: migration 47 — question_requests
- 2026-08-03T15:55:44.291Z - task-done: T8: endpoint /api/hooks/ask-question, blocking
- 2026-08-03T15:55:44.378Z - task-done: T9: callback handler for ask:
- 2026-08-03T15:55:44.467Z - task-done: T10: scripts/ask-question-hook.sh
- 2026-08-03T15:55:44.553Z - task-done: T11: supervisor: waiting on a question is not hung
- 2026-08-03T15:55:44.640Z - task-done: T12: cli.ts: register the PreToolUse hook
- 2026-08-03T15:55:44.726Z - task-done: T13: tests for all of the above
- 2026-08-03T15:55:44.815Z - task-done: T14: full gate
- 2026-08-03T15:55:44.906Z - ac-confirmed: AC1: parseHookInput declines the whole call unless every question is representable; another tool, unparseable input, no options, multiSelect and blank all return null
- 2026-08-03T15:55:44.995Z - ac-confirmed: AC2: questionMessage carries question, numbered options and descriptions; everything escaped, asserted with < and &
- 2026-08-03T15:55:45.088Z - ac-confirmed: AC3: callback round-trip, foreign payloads rejected, payload within 64 bytes
- 2026-08-03T15:55:45.175Z - ac-confirmed: AC4: denyWithAnswers is a PreToolUse deny naming each question with its chosen option
- 2026-08-03T15:55:45.266Z - ac-confirmed: AC5: allAnswered requires every slot; option index zero counts
- 2026-08-03T15:55:45.352Z - ac-confirmed: AC6: resolveTarget queries by project_path not by Claude's session id; forum topic preferred; half a forum config is not a target
- 2026-08-03T15:55:45.440Z - ac-confirmed: AC7: insert-before-send asserted by observing the insert count from inside the first send
- 2026-08-03T15:55:45.529Z - ac-confirmed: AC8: nowhere to send and any failed send both withdraw the request
- 2026-08-03T15:55:45.619Z - ac-confirmed: AC9: jsonb_set with the guard in the statement; message edited; distinct outcome for not-ours/unknown/already-answered/expired/out-of-range
- 2026-08-03T15:55:45.707Z - ac-confirmed: AC10: answers returned from the winning claim; null on timeout, vanished row, external expiry, non-index values, incomplete commit
- 2026-08-03T15:55:45.802Z - ac-confirmed: AC11: local-only plus shared secret; body bounded; waiters capped; disconnect cancels; 204 on every terminal-keeps-it path
- 2026-08-03T15:55:45.903Z - ac-confirmed: AC12: hook exits 0 silently without a token, without a bot, on timeout and on a non-question payload
- 2026-08-03T15:55:46.002Z - ac-confirmed: AC13: hasOpenQuestion excludes answered and expired and is bounded to 15 minutes; checkHungSessions skips such a session
- 2026-08-03T15:55:46.095Z - ac-confirmed: AC14: setupAskQuestionHook registers with matcher AskUserQuestion and timeout 600, is idempotent, prunes stale entries before the ephemeral gate
- 2026-08-03T15:55:46.188Z - ac-confirmed: AC15: typecheck clean, lint 0 errors, 875 tests pass, dupes 1

## Review: seven rounds, and every one of them was earned

The first round returned three blockers, all of the same shape: this feature
could make the terminal *worse* than it is today.

- Carrying the questions that fit and dropping one that does not — a free-text
  question, or a multi-select — looked accommodating and was a trap. An answer
  to the others denies the whole tool call, so the dropped question would never
  be put to anyone.
- Partial Telegram delivery was worse. The questions that arrived could be
  answered; the one that did not never could; the call therefore never
  completed, and the selector stayed suppressed for the full ten minutes.
- Two buttons tapped at once each carried the other's slot as it was before,
  because the answer array was read, changed and written back whole.

The pattern in all three: a partial success treated as a success. Both of the
first two are now all-or-nothing, and the third is a `jsonb_set` that touches
only the slot being answered.

Then four more rounds, each closing what the previous fix had left:

- The capacity check and the disconnect watch were installed *after*
  registration, so every concurrent caller passed the check and sent its
  prompts before any of them counted.
- The two terminal states could both be set. Guarding them made the state
  exclusive but not the *reporting*: a tap that lost still said "already
  answered" when a cancel may have been what beat it.
- The answers were read, then claimed — and a tap landing between the two would
  have handed Claude one option while the row and the operator's own message
  recorded another.
- The disconnect signal reached the exchange but not the poll loop, so a curl
  that gave up while the operator was still deciding held a waiter slot for ten
  minutes.

Every one of those is the same failure mode wearing a different hat: *checking
a condition once, at a moment that turns out not to be the moment that
matters*. The probe that typed a keystroke into an empty prompt earlier in this
flow was the first instance. It is worth naming as its own lesson.

The seventh round approved.

### What made it reviewable

`runQuestionExchange` exists because the ordering was wrong twice and could not
be tested from the HTTP handler. Extracting it made the third attempt provable
rather than argued.

### Numbers

Tests 801 → 875. Health 64 → 65. `bun run dupes` still 1.

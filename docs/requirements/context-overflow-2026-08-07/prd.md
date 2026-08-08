# Summarize Before The Context Folds — PRD

Version: 1.0.0

## 1. Problem

Claude Code compacts its own context when it fills. The session survives; what
Helyx knows about it does not. The summary Helyx would have written — decisions,
constraints, what the session was actually doing — is written from the
transcript, and by the time anyone notices the fold, the part worth summarising
has already been replaced by Claude's own compaction summary.

Helyx has a summariser and does not run it at the moment that matters.
`memory/summarizer.ts` exposes `forceSummarize()`, and the supervisor calls it
on one trigger only: a session idle for `IDLE_COMPACT_MIN` minutes with at least
ten messages (`scripts/supervisor.ts`, the idle auto-compact loop). A session
that is *busy* — the one filling its context — never reaches that trigger. The
fold happens mid-work, and nothing runs.

There is no signal today. The status message carries `↓ N tokens`, which is
`output_tokens` for the current turn (`utils/transcript-events.ts:259`,
documented there as deliberately not the cache or input counts). It says nothing
about how full the window is.

## 2. What is measurable, and what it costs to measure

The transcript already carries the answer. Every assistant entry records
`message.usage`, and the type is already declared in
`utils/transcript-locate.ts:46`. The context size is the sum of three fields:

```
input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

Measured on this repository's own session at the time of writing:

| Field | Value |
|---|---|
| `input_tokens` | 2 |
| `cache_creation_input_tokens` | 1 113 |
| `cache_read_input_tokens` | 610 456 |
| **context** | **611 571** |

The cost of reading it is the cost of reading the tail of one file.
`resolveTranscript()` and `parseEntry()` already exist and are already used by
`/now`, which reads the transcript directly precisely because the queue path
cannot reach a wedged session.

What is *not* measurable from the transcript is the denominator. The percentage
needs a window size, and the window depends on the model, which in this project
is per-project and switchable (`/providers`, `bot/commands/providers.ts`). A
percentage computed against the wrong window is worse than no percentage: it
fires early on a large window and never on a small one.

## 3. Why 98% is the wrong number

The operator's instinct was to act at 98%. Three things argue for lower:

1. **Summarising needs headroom.** The summariser reads the session's own
   messages and calls an aux LLM. At 98% there may not be room to do the work
   that the trigger exists to cause.
2. **Auto-compaction does not wait for 98%.** Claude Code folds on its own
   schedule, ahead of the hard limit. A trigger set above that point never
   fires — the fold happens first, every time, and the feature is dead code.
3. **A percentage from `usage` lags by one turn.** It is the usage of the last
   completed assistant message. The next tool result can add tens of thousands
   of tokens before anything is measured again.

85% is the proposed default, configurable. It is early enough to leave room and
late enough not to summarise a session that was never going to fold.

## 4. Three layers, and why all three

### Layer 1 — the watcher (primary)

A supervisor loop, alongside the nine that already run there. Every tick it
reads the tail of each active session's transcript, computes the percentage, and
at or above the threshold runs `forceSummarize()`.

This is the layer that does the useful work, because it is the only one that
runs *before* the fold with time to spare.

It must not interrupt. A session mid-turn gets summarised on the next tick, not
this one — the idle signal the status manager already tracks is the gate.

### Layer 2 — `PreCompact` (the safety net)

Claude Code fires `PreCompact` before folding, with a matcher distinguishing
`manual` from `auto`. Helyx already installs two hooks this way — `Stop`
(`scripts/save-session-facts.sh` → `/api/hooks/stop`) and `PreToolUse`
(`scripts/ask-question-hook.sh` → `/api/hooks/ask-question`) — so a third is the
same shape, not a new mechanism.

This layer exists for the case the watcher cannot catch: context that grows in
one step. A single large file read, a long test log, a subagent's report — the
watcher measured 60% one turn ago and the fold is now.

**It will not block.** `PreCompact` can block compaction (exit code 2, or
`decision: "block"`). Using that to buy time makes a hung summariser into a hung
session, and a session that cannot compact cannot continue. The hook does its
work inline under a hard timeout and returns; if the timeout expires,
compaction proceeds without the summary, which is the situation we have today
and therefore not a regression.

### Layer 3 — what the fold leaves behind (out of scope, stated for the record)

After compaction the session carries Claude's summary and not Helyx's. Putting
the Helyx summary back is a `PostCompact` or `SessionStart(compact)` concern,
and the mechanism already exists — `/resume` injects the last saved summary into
the queue. It is deliberately **not** in this flow: it is a separate decision
about what belongs in a fresh context, and layers 1 and 2 are worth having
without it.

## 5. Acceptance

- The context percentage of a live session is computable from its transcript,
  with no terminal scraping and no extra process.
- A session crossing the threshold while idle is summarised before it folds.
- A session crossing it mid-turn is left alone until it is not.
- A fold that arrives before the watcher does still gets a summary attempt,
  bounded in time, and never prevents the fold.
- An unknown model falls back to a documented default window rather than
  guessing a percentage from a number it does not have.
- Every threshold and window is configurable and defaulted in one place.

## 6. Out of scope

- Re-injecting the summary after compaction (layer 3 above).
- Sending `/compact` on Helyx's initiative. Summarising first is the goal;
  deciding *when the agent folds* is a larger change and a different argument.
- Changing what `forceSummarize()` writes.
- Per-provider token accounting or cost reporting.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Wrong window size for a model → threshold never fires, or fires constantly | One table, one documented default, and the percentage is logged so a wrong denominator is visible rather than silent |
| The watcher summarises the same session every tick | A recorded high-water mark per session; summarise once per crossing, not once per tick |
| The hook adds latency to every compaction | Hard timeout, and the hook is a shell script that returns immediately if the bot is not reachable — the same shape the two existing hooks already use |
| A stale hook registration after the checkout moves | The wizard prunes stale entries before adding, as it already does for `Stop` and `PreToolUse` |

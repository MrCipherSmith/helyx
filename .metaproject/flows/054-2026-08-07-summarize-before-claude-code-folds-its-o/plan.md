# Implementation Plan

Status: ready

## Approach

Put the arithmetic in a pure module and the decisions in a supervisor loop.
Everything about "how full is it" — reading `usage`, summing the three fields,
the model-to-window table, the threshold comparison — is a function of its
inputs and is tested as one. The loop contributes only which sessions to look
at, whether they are idle, and whether this crossing has already been handled.

The hook is a shell script that posts to the bot, because that is what the two
existing hooks are and a third of the same shape needs no new mechanism and no
new failure mode.

Rejected: scraping the context from the terminal. The number the CLI prints is
per-turn output, the pane is redrawn, and `/now` already established that the
transcript is the reliable source.

Rejected: blocking compaction in `PreCompact` to buy time for the summary. It is
supported, and it converts a slow summariser into a session that cannot
continue.

## Steps

1. `utils/context-usage.ts` — pure: `contextTokens(entry)`, `windowFor(model)`
   with a documented default, `usageRatio()`, and the crossing decision.
2. Read the tail of a transcript for the newest entry carrying `usage`, reusing
   `resolveTranscript`/`parseEntry`.
3. Supervisor loop: for each active session, compute the ratio; if at or above
   the threshold, the session is idle, and this crossing has not been handled,
   call `forceSummarize()` and record the high-water mark.
4. `scripts/pre-compact-hook.sh` + `POST /api/hooks/pre-compact` — summarise
   inline under a hard timeout; always exit 0.
5. Register the hook in the setup wizard, pruning stale entries the way the two
   existing installers do.
6. Config: threshold and default window in `config.ts`, documented.
7. Tests for the arithmetic, the window fallback, the once-per-crossing rule,
   the idle gate, and the hook endpoint's timeout behaviour.

## Risks

- A wrong window makes the percentage meaningless. Mitigated by logging the
  computed ratio and the window it used, so a wrong denominator is visible.
- The loop could summarise the same session every tick. Mitigated by the
  high-water mark: once per crossing, not once per tick.
- The hook adds latency to every compaction. Mitigated by the timeout and by
  returning immediately when the bot is unreachable.

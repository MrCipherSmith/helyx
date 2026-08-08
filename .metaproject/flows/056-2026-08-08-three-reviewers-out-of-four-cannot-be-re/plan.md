# Implementation Plan

Status: ready

## Approach

Four changes in `services/reviewer-service.ts`, in increasing order of how much
they can break, plus the config swap and the `/reviewers_add` surface.

The first is additive: a third `ReviewerKind`. `codex` already establishes the
shape — build an argv, spawn it, read stdout, classify the failure — so
`claude` follows it rather than inventing a second way to run a CLI.

The second is a correction to one function. `normalizeProviderBaseUrl` guesses
an OpenAI route by removing a suffix, which is not a general rule and never
was — it is right for one of the four vendors registered. It becomes an
explicit map from vendor host to real route, with the current stripping kept as
the fallback for a vendor nobody has taught it about.

The third is a reading rule: a body that announces its own failure is a
failure. This is what turns "empty response" back into "404 NOT_FOUND".

The fourth is the environment. The `claude` reviewer must not inherit
`CHANNEL_SOURCE`, and must not load the global MCP servers, or it takes the
lease of the session that asked for the review. This is the part that is
asserted by a test rather than assumed, because its failure is silent.

## Steps

1. `ReviewerKind` gains `"claude"`; `claudeArgv()` and `claudeEnv()` are
   separate exported functions so a test can read both without a CLI on the
   machine.
2. `callClaudeReview()` spawns it and classifies failure, reusing the Codex
   classifier where the wording is the same (`not logged in`, usage limits).
3. `openAiRouteFor(baseUrl)` — the vendor map, with the old strip as fallback.
4. `providerErrorInBody(body)` — recognises the envelopes a 200 uses to report
   a failure, so the reviewer names the cause.
5. `/reviewers_add claude [model]` and the reviewer line renderer learn the new
   kind; `defaultReviewers()` is left alone.
6. Swap the OpenRouter reviewer (`provider:2`) in `bot_config` for the new
   `claude` one.
7. Tests for all four, plus the environment-clearing.

## Risks

- A CLI reviewer inherits whatever environment the supervisor has. That is the
  whole risk of steps 1–2, it has already cost one session today, and it is why
  the clearing is asserted rather than assumed.
- The vendor map is a table, and this repository has already been bitten twice
  this week by tables that fell behind. Hence the fallback, and hence naming
  the vendor in the error when the fallback is what answered.
- `claude -p` on the subscription consumes the operator's own quota, shared
  with the sessions. Nothing here bounds that beyond the existing review
  timeout.

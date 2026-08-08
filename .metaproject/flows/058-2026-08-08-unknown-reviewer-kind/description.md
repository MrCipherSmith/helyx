# An unknown reviewer kind fails as itself, not as a provider

Status: formalized
Source: user description (operator, 2026-08-08)

## Problem

`runOne` in `services/reviewer-service.ts` dispatches on `reviewer.kind` with two
tests and a fallthrough: `codex`, then `claude`, then *everything else* goes to
`callProviderReview`. The reviewer set is JSON in `bot_config`, written by one
build and read by whichever build is running — so a kind the running code does
not know is not hypothetical.

It already happened. `kind: "claude"` was added in flow #056; a checkout from
before it read the same stored row, fell through to the provider path, looked up
`providers.id = undefined`, and reported `[provider#undefined] unavailable:
unknown provider`. That names the wrong thing entirely: the provider table was
fine, the reviewer was not a provider reviewer, and an operator reading it goes
looking for a broken provider row that does not exist — which is exactly the
half-hour this flow exists to prevent next time.

`reviewerAvailability` has the same fallthrough and prints the same wrong detail
in `/reviewers_status`.

## Expected Outcome

A reviewer whose `kind` the running build does not recognise reports that, by
name: the stored kind, in the error, from both the run path and the status path.
The three known kinds are dispatched explicitly, so adding a fourth without
wiring it fails loudly instead of impersonating a provider. Existing behaviour
for `codex`, `claude` and `provider` is unchanged, including a genuinely missing
provider row still reading `unknown provider`.

## Out of Scope

- The reviewers that are down for external reasons (Codex rate limit, DeepSeek
  and GLM balance). Not a code problem.
- Migrating or validating the stored `bot_config.reviewers` JSON on read.
- Any change to what the reviewers are asked or how their reports are rendered.

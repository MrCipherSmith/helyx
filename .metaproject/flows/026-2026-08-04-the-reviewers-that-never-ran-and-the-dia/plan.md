# Implementation Plan

Status: chosen

## Approach

Fix the five defects, and make the two functions that hold them testable in the
same pass — because the reason all five survived is that nothing could reach
them.

**Make the world an argument.**
`callCodexReview` and `callProviderReview` gain optional injection points: a
spawn function and a fetch function, defaulting to the real ones. Nothing about
production behaviour changes; what changes is that a test can drive them.
`tests/fixtures/fake-fetch.ts` already exists and is used this way by
`llm-client-stream.test.ts`, so the provider half costs a fixture that is
already written. The module's own doc comment claims this rule today — this
makes the claim true.

**Codex: `exec`, and say what actually happened.**
The spawn becomes `codex exec -m <model> <prompt>`. The failure string stops
being one string. The classification is a small pure function over exit code,
stdout and stderr, because that is the part worth testing and the part that lied:

| Signal | Reported as |
|---|---|
| `unexpected argument`, `unrecognized subcommand`, usage text | `cli-usage` |
| `not supported when using Codex with` | `model-unsupported` |
| `rate limit`, `quota` | `limit` |
| `unauthorized`, `not logged` | `auth` |
| non-zero exit, nothing else matched | `failed (exit N)` |
| exit 0 and empty stdout | `empty output` |

The point is not the taxonomy. It is that a malformed command can never again be
reported as a spent quota.

**Provider: room to answer, the right header, and the diff.**
`max_tokens` rises to a figure a reasoning model can finish inside; the flow
uses 32,000, which is 8× the measured wall. Where the answer still comes back
empty with `finish_reason: "length"`, that is reported as `truncated: reasoning
consumed the budget` rather than `empty response` — the same principle as
Codex's classification, applied to the failure this flow actually found.

The header follows `providers.auth_scheme`, the way `fetchProviderModels`
already does. The rule is extracted so both call sites read it from one place
rather than restating it — the second restatement is what this flow is fixing.

**The diff belongs to the service.**
`runReviewers` takes the operator's request and builds the prompt: the request,
then the diff against the merge base, bounded. The caller stops being
responsible for something it was never told to do. `scripts/review.ts` keeps
passing a sentence; the diff is attached beneath it.

Bounded, because the measurement above shows a 66 KB diff is accepted while a
much larger one would not be, and a silently truncated diff is a blind review
wearing a disguise. Over the bound, the diff is cut and the prompt says so in
words the model will read.

### Rejected

- **`codex review` instead of `codex exec`.** It is the purpose-built
  subcommand, but it takes the review scope from git rather than from our
  prompt, which would make the Codex reviewer answer a different question than
  the provider reviewer. Worth revisiting on its own.
- **Changing the configured Codex model here.** `gpt-4.5-mini` is unusable on
  this account, but which model to use is an operator decision made through
  `/reviewers`, and hardcoding a replacement in the service would take it away.
  The fix makes the failure legible; the operator picks.
- **Attaching the diff in `scripts/review.ts`.** It is the smaller edit and the
  wrong place: the MCP path and the Telegram path call `runReviewers` too, and
  each would need its own copy of the same knowledge.
- **Raising `max_tokens` and nothing else.** It would make today's symptom go
  away and leave the report lying about the next one.

## Steps

1. Extract the auth-header rule so both call sites share it; use it in
   `callProviderReview`.
2. `classifyCodexFailure` — pure, over exit code and output.
3. `callCodexReview`: `codex exec`, injectable spawn, real classification.
4. `callProviderReview`: injectable fetch, `max_tokens` sized for reasoning,
   truncation reported as truncation.
5. `buildReviewPrompt` — request plus bounded diff; `runReviewers` uses it.
6. Tests over all of the above, with the fake fetch and a fake spawn.
7. Full gate, then run the reviewers on PR #61 for real.

## Risks

- **32,000 output tokens is a guess about a ceiling, not a measurement.** It is
  8× what was observed to be insufficient, and the truncation report exists
  precisely because a guess can be wrong. If a provider rejects the figure the
  request fails loudly with an http error rather than silently with an empty
  string.
- **A larger prompt costs more per review.** Attaching the diff is the point of
  the exercise, and a blind review costs the same money for nothing.
- **The Codex CLI can move again.** That is what the `cli-usage` classification
  is for: the next rename is reported as a usage error on the first run instead
  of masquerading as a quota for months.
- **Bounding the diff can hide a change.** Mitigated by saying so in the prompt,
  and by the bound being generous relative to what was measured to work.

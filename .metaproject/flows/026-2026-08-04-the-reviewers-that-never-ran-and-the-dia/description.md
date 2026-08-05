# the reviewers that never ran, and the diagnosis that said otherwise

Status: formalized
Source: user description (run the reviewers on PR #61 and check whether Codex
and DeepSeek start)

## Problem

Asked to review a pull request, both reviewers failed. Neither failure was new,
and neither was reported honestly.

**Codex has been calling a flag that does not exist.**
`services/reviewer-service.ts:126` spawns `npx @openai/codex --no-interactive`.
The CLI answers:

```
error: unexpected argument '--no-interactive' found
  tip: a similar argument exists: '--no-alt-screen'
```

Non-interactive mode moved to a subcommand (`codex exec`) at some point and the
call was never updated. Worse, `callCodexReview` maps *any* non-zero exit and
*any* empty stdout to the single string `"limit/auth/unavailable"`, so every
report for however long has said "rate limit or auth" about a usage error. The
operator was told a story about quota while the command was malformed.

Behind that, a second wall: the configured model `gpt-4.5-mini` returns
`The 'gpt-4.5-mini' model is not supported when using Codex with a ChatGPT
account`. Verified that `codex exec` with the account's default model answers
normally — the login is fine.

**DeepSeek spends its whole answer on thinking.**
`callProviderReview` sends `max_tokens: 4096`. On `deepseek-v4-pro`, a reasoning
model, that budget covers reasoning *and* the reply. Measured against the real
endpoint with the real diff:

```
finish_reason: length
completion_tokens: 4096
reasoning_tokens:  4096
content length:    0
```

Every token went to reasoning and none was left for the review. The code sees an
empty string and reports `"empty response"` — true, and useless. The failure
scales the wrong way: a trivial prompt is answered, a real diff is not, so the
reviewer is silent exactly when it is worth having.

**Nothing gives the provider the diff.**
`callProviderReview` sends the caller's prompt and nothing else. CLAUDE.md
claims each provider model "reads the git diff itself from the prompt", but
there is no code that puts a diff there, and `scripts/review.ts` passes only the
user's sentence. Asked to review PR #61, DeepSeek replied — correctly — that it
had been shown no code. Every provider review so far has been made blind.

**A provider on `x-api-key` would 401.**
The `providers` table carries `auth_scheme`, and `fetchProviderModels` honours
it: `api_key` means the `x-api-key` header. `callProviderReview` hardcodes
`Authorization: Bearer`. DeepSeek is a bearer provider so this has not fired
yet; the first Anthropic-compatible reviewer would get a 401 and be filed, once
again, under "limit/auth".

The common thread is the last one. `callCodexReview` and `callProviderReview`
are the only two functions in the module that touch the world, and they are the
only two with no test — `tests/unit/reviewer-service.test.ts` covers the pure
helpers and says so in its own header. The module's doc comment states the rule
it breaks: "the network and the database can be faked in a test". Four defects
lived behind that gap, and a fifth is waiting.

## Expected Outcome

- Codex runs, or says accurately why it did not.
- A provider reviewer receives the diff and has room to answer.
- A failure names its cause. "limit/auth/unavailable" is reserved for an actual
  limit or auth problem, and a usage error, a bad model and a truncated answer
  are each distinguishable in the report.
- The two functions that call out to the world are reachable from a test, which
  is how the next such defect gets caught before an operator does.

## Out of Scope

- Choosing which Codex model the account should use. The invocation is fixed
  here; which model is configured stays an operator decision through
  `/reviewers`.
- Reworking `/reviewers` command UX.
- Adding new reviewers or providers.
- Anything about PR #61's own content — this flow fixes the reviewers, and the
  review of that PR is what it is for.

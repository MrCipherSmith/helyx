# Context

Collected deterministically by `keryx flow init` at 2026-08-04T23:08:08.586Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/known-mistake] A comment that claims agreement is not a mechanism - `.metaproject/memory/known-mistakes/comment-asserts-more-than-code.md`
- [accepted/task-note] Coverage programme: what is done, what is open, what is next - `.metaproject/memory/task-notes/coverage-programme-state.md`
- [accepted/known-mistake] One rule in several files diverges, and review does not catch it - `.metaproject/memory/known-mistakes/duplicated-knowledge-diverges.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-04T17:37:31.139Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdwiki
- gdskills
- memory
- tasks
- health
- testing
- security

## Agent Findings

### Measured, not inferred

Every claim below was produced by running the thing, not by reading it.

**Codex, current CLI (v0.146.0):**

```
$ npx @openai/codex --no-interactive -m gpt-4.5-mini "say ok"
error: unexpected argument '--no-interactive' found
  tip: a similar argument exists: '--no-alt-screen'

$ npx @openai/codex exec -m gpt-4.5-mini "reply with exactly: ok"
ERROR: {"status":400,"error":{"message":"The 'gpt-4.5-mini' model is not
supported when using Codex with a ChatGPT account."}}

$ npx @openai/codex exec "reply with exactly: ok"
ok          ← the account's default model answers; login is fine
```

`codex --help` lists `exec  Run Codex non-interactively [aliases: e]` and also
`review  Run a code review non-interactively`. Either is a candidate; `exec` is
the smaller change and keeps the prompt ours.

**DeepSeek, real endpoint, real diff:**

| prompt chars | http | finish_reason | completion | reasoning | content |
|---|---|---|---|---|---|
| 20,000 | 200 | length | 4096 | 4096 | 0 |
| 66,349 | 200 | length | 4096 | 4096 | 0 |

`reasoning_tokens` equals `completion_tokens` at both sizes: the cap is reached
inside the reasoning phase and the answer never starts. It is not a context
limit — `prompt_tokens` was 18,577 on the larger run and the request was
accepted.

### The shape of the defects

| # | Where | Defect |
|---|---|---|
| 1 | `reviewer-service.ts:126` | `--no-interactive` no longer exists; `codex exec` does |
| 2 | `reviewer-service.ts:138-140` | every non-zero exit and every empty stdout becomes `"limit/auth/unavailable"` |
| 3 | `reviewer-service.ts:165` | `max_tokens: 4096` is consumed by reasoning on a reasoning model |
| 4 | `reviewer-service.ts:163` + `scripts/review.ts:16` | nothing puts the diff in the prompt, though CLAUDE.md says the model reads one |
| 5 | `reviewer-service.ts:158` | `Authorization: Bearer` hardcoded, ignoring `providers.auth_scheme` |

Defect 5 has not fired: DeepSeek is a bearer provider. `fetchProviderModels`
(`provider-service.ts`) already gets this right — `api_key` → `x-api-key` — so
the correct behaviour exists in the codebase and one of the two call sites does
not use it. Squarely the `duplicated-knowledge-diverges` pattern this flow was
initialised with.

### Why all five survived

`tests/unit/reviewer-service.test.ts` opens by saying what it does not cover:

> The network and the database are deliberately left out.

That was a defensible call for `pickMode` and `normalizeProviderBaseUrl`. But
`callCodexReview` and `callProviderReview` are the only two functions in the
module that reach the world, and they are precisely the two with no test. The
module header states the rule they break:

> it follows the same "take sql and the world as arguments" rule as
> `ask-question.ts`: the network and the database can be faked in a test

They do not take the world as an argument. `callCodexReview` calls `Bun.spawn`
directly; `callProviderReview` calls global `fetch`. Making them injectable is
not tidying — it is the difference between these five defects being caught by a
test run and being caught by an operator asking why a review is empty.

`tests/fixtures/fake-fetch.ts` already exists for exactly this and is used by
`llm-client-stream.test.ts`.

### What the reviewers said when they did run

The first run, before the diff was attached:

```
[Codex (gpt-4.5-mini)] unavailable: limit/auth/unavailable

===== DeepSeek (deepseek-v4-pro) =====
I don't have access to the PR diff or file contents—no code was provided.
```

The provider was right, and its answer is the clearest statement of defect 4 in
the record.

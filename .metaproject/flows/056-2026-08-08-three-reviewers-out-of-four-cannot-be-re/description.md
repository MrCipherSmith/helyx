# Three reviewers out of four cannot be reached, and one of them says so as an empty answer

Status: formalized
Source: operator report, 2026-08-08 — the merge gate now depends on a clean review

## Problem

Every merge now waits on a clean reviewer report. None of the four registered
reviewers can produce one, and only one of the four reasons is a real outage.

| Reviewer | Reported | Actually |
|---|---|---|
| Codex `gpt-5.6-sol` | `limit until aug 11th` | True, and account-wide: `codex exec -m gpt-5.6-terra` answers `You've hit your usage limit` too, so lowering the model does not help |
| DeepSeek | `limit/balance` | Account-side, needs the operator |
| GLM `glm-5.2` | `empty response` | We call a route that does not exist |
| OpenRouter | `http 404` | Same, plus the operator has no credit there |

The last two are ours. `callProviderReview` derives an OpenAI-compatible URL by
stripping `/anthropic` or `/v1` off the provider's stored base URL and
appending `/chat/completions`. The stored URL is the *Anthropic* one, because
that is what a Claude Code session needs. Measured against the rows actually in
`providers`, the derivation lands on a real route for exactly one vendor:

- DeepSeek `https://api.deepseek.com/anthropic` → `…/chat/completions` — works.
  This is the one that made the heuristic look like a rule.
- OpenRouter `https://openrouter.ai/api` → `openrouter.ai/api/chat/completions`
  — 404. The route is `/api/v1/chat/completions`.
- GLM `https://api.z.ai/api/anthropic` → `api.z.ai/api/chat/completions` — and
  z.ai answers **HTTP 200** with `{"code":500,"msg":"404 NOT_FOUND","success":false}`
  in the body. The call succeeds, the parse finds no content, and the operator
  is told "empty response" — a wrong route reported as a quiet model.
- Kimi `https://api.moonshot.ai/anthropic` → also wrong (`/v1` is required).
  Not a reviewer today, so nobody has been told about it yet.

Separately, the operator wants the independent Claude reviewer to run on the
Claude Code subscription he already pays for rather than through OpenRouter,
where he has no credit. Verified working:
`env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY claude -p --model claude-opus-5`
answers `OK` headlessly on the subscription. All four variables matter: leaving
`ANTHROPIC_API_KEY` set produces `Not logged in · Please run /login`.

**And clearing them is not sufficient.** The run above is what killed the
session that performed it. `scripts/run-cli.sh:137` starts a session as
`CHANNEL_SOURCE=remote claude …` — a prefix assignment, so the variable is in
the session's own environment and every child of its Bash tool inherits it. The
nested `claude` therefore registered as a *remote session for the same project*
and took the channel lease from its own parent: at 07:45:47 the bot logged
`sessionId 3 … trigger:"disconnect"` while the parent was still running, and
the next three operator messages routed with `mode:"disconnected"` into a queue
nobody drained for 22 minutes. A reviewer that shells out to `claude` runs on
every review; without clearing `CHANNEL_SOURCE` and isolating the MCP config it
would do this every time.

## Expected Outcome

- A `claude` reviewer kind that shells out to the Claude Code CLI on the
  operator's subscription, the way the `codex` kind shells out to its own CLI,
  with the provider environment *and* the channel environment explicitly
  cleared, and with the global MCP servers not loaded.
- Provider routes that resolve for more than one vendor.
- A 200 response carrying an error is reported as that error, not as emptiness.

## Out of Scope

- The credentials themselves. DeepSeek's balance, and the GLM key, are the
  operator's to renew; no code change substitutes for a live key.
- Codex's limit. It lifts on 2026-08-11 by itself.
- The general problem of a nested `claude` stealing a session lease. This flow
  makes the reviewer safe; it does not make `CHANNEL_SOURCE` inheritance safe
  for every other caller.

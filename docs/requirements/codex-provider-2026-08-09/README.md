# Claude Code Talking to a Codex Subscription

Version: 1.1.0

## Purpose

Let a project run Claude Code against OpenAI Codex — through the operator's
already-authenticated ChatGPT subscription, not a new credential — the same
way it already runs against GLM, Kimi, DeepSeek or the local Ollama model: by
picking a provider in Telegram, with nothing changed outside that project's
own launch. The point is a fallback for when the default Anthropic quota is
spent: the tmux window keeps running `claude`, only the backend moves.

## Status

`draft` — written 2026-08-09, spike run the same day. §"What is different
from the Ollama precedent" below described an open technical question this
package could not answer from documentation alone; it has since been
answered, negative — see [spike-findings.md](spike-findings.md). The clean
translation design (`specification.md` §Option B) is not viable with what
`codex exec` currently exposes. The reduced-fidelity fallback (§Option A)
is the only path left open, and building it is a decision still waiting on
the operator — nothing beyond the spike has been built.

| Question | Answer | Source |
|---|---|---|
| Is there a custom-provider slot already? | Yes — `custom`, deliberately open-ended | `bot/providers/presets.ts:87-94` |
| How does a provider reach Claude Code? | Per-process env, evaluated at launch | `scripts/resolve-provider-env.ts:46-75`, `scripts/run-cli.sh:58-63` |
| Can OpenAI/Codex be pointed at directly via `ANTHROPIC_BASE_URL`? | No — Claude Code sends Anthropic `POST /v1/messages`; OpenAI has no such route. (Ollama grew one in v0.14+; OpenAI has not.) | same trap recorded for OpenRouter, `bot/providers/presets.ts:75-78` |
| Is Codex already authenticated in helyx? | Yes — `/codex_setup` does a real OAuth device-code login against the operator's ChatGPT Plus/Pro account, today used only to run one-shot reviews | `bot/commands/codex.ts:7-120` |
| Does `codex exec` behave like Ollama's `/api/chat` — a stateless model call that returns tool-call decisions without executing them? | **No evidence that it does.** `codex exec` is a self-driving coding agent: given a prompt it reads and can write files and run shell commands itself, inside a sandbox policy it also controls. Verified against the installed CLI, `codex-cli 0.147.0`, `codex exec --help`, 2026-08-09. | see table below |
| Is there a place for a host-side daemon and a health heartbeat? | Yes — `ollama-proxy` is started this way and heartbeats into `process_health` | `cli.ts:1565-1582`, `memory/db.ts:459+` |

### `codex exec` flags relevant to this design (codex-cli 0.147.0)

| Flag | Effect | Relevance |
|---|---|---|
| `-s, --sandbox <read-only\|workspace-write\|danger-full-access>` | Constrains what Codex's own tool calls may touch | Bounds the risk of Codex silently editing files behind Claude Code's back — does not remove it |
| `--json` | Emits events as JSONL instead of prose | The candidate channel for capturing structured turn/tool events, if the spike shows they're granular enough |
| `--output-schema <FILE>` | Constrains the final answer's shape | Could pin the final text block's shape; does not address in-turn tool calls |
| `-o, --output-last-message <FILE>` | Writes only the final message to a file | Cleaner than parsing CLI chrome, which `services/reviewer-service.ts`'s `CODEX_DIRECTIVE` currently works around |
| `resume --last` | Continues a previous `codex exec` session by id | Means each turn need not resend full history the way the Ollama translator does — Codex can hold its own session state |
| `--ephemeral` | No session files persisted to disk | Avoids on-disk buildup across many short-lived proxy calls |

## What went wrong on a similar first attempt

`claude-code-router` was installed on this host on 2026-08-07 and wrote into
the **global** `~/.claude/settings.json`, stopping every Claude Code session
until it was found and reverted — see
[`docs/requirements/ollama-provider-2026-08-07/README.md`](../ollama-provider-2026-08-07/README.md)
§"What went wrong on the first attempt" for the full account. The lesson
carries over unchanged: **the blast radius of selecting a provider must stay
inside the project that selected it.** Nothing in this design may write to
`~/.claude/settings.json` or any other global Claude Code configuration.

## What is different from the Ollama precedent

`docs/requirements/ollama-provider-2026-08-07` translates Anthropic's
Messages API into Ollama's `/api/chat` — a real stateless model endpoint that
takes a conversation plus tool definitions and returns tool-call *decisions*,
which Claude Code's own tool loop then executes. That mapping is clean
because both sides agree on the same division of labour: the model decides,
the client acts.

`codex exec` does not obviously offer that division. It is a product that
decides *and* acts, inside its own sandboxed shell/file tools, in one
invocation. Handing it a Claude-Code-shaped `tool_use`/`tool_result`
transcript and expecting back a single `tool_use` block — without Codex
having already run something itself — is the open question this package
does not resolve. See [prd.md](prd.md) §Risks (R1) and the Phase 0 spike it
recommends before any daemon code is written.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, established facts, the open question |
| [prd.md](prd.md) | Problem, goal, requirements, risks (R1 is the one that matters), recommendation |
| [specification.md](specification.md) | Module identity, storage reuse, daemon design for both possible outcomes of the spike, acceptance criteria |
| [spike-findings.md](spike-findings.md) | The Phase 0 spike, run 2026-08-09: three real `codex exec --json` calls, quoted verbatim — Option B is not viable, Option A is what's left |

## Scope and Non-Goals

In scope: a per-project provider option that runs Codex behind the existing
`claude` binary and the existing provider-selection mechanism, authenticated
through the login helyx already has.

Not in scope:

- Running the `codex` binary itself as the interactive session engine in
  place of `claude` (a different, larger feature — see the memory note
  `architecture_codex_review_vs_session_engine` from the session that scoped
  this package: manual/automatic engine switching, MCP config translation,
  `run-cli.sh` output-parsing rewrite. Out of scope here on purpose — this
  package keeps `claude` as the binary in every case).
- Automatic switching triggered by Claude's own limit detection (Flow 061).
  This package only adds the provider option; whether and how a project
  switches to it is a separate, later decision.
- Reusing any third-party Claude-Code↔Codex proxy (`raine/claude-code-proxy`
  and similar, researched the same session). Rejected in favour of wrapping
  helyx's own already-authenticated official `codex` binary — smaller trust
  surface, no new OAuth implementation, no dependency on a project with its
  own account-risk posture.

## Related Modules

- `bot/providers/presets.ts`, `services/provider-service.ts`,
  `scripts/resolve-provider-env.ts` — the provider-selection mechanism this
  package plugs into, unchanged.
- `scripts/ollama-proxy.ts`, `utils/anthropic-ollama.ts`,
  `utils/ollama-proxy-settings.ts` — the sibling proxy this design mirrors.
- `bot/commands/codex.ts`, `services/reviewer-service.ts` — the existing
  Codex login and one-shot invocation this package reuses rather than
  reimplements.

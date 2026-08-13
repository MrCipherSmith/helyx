# Codex as a Second Session Engine

Version: 1.0.0

## Purpose

Let a project's interactive tmux session run on OpenAI Codex instead of
Claude Code — a different binary in the same window, switchable from
Telegram the way a provider is switched today — so that when the operator's
Claude usage limit is hit, the conversation can continue on the Codex
subscription rather than wait it out. Unlike
`docs/requirements/codex-provider-2026-08-09` (Codex hidden behind `claude`
as a translated backend — spiked, and its clean-translation design ruled
out), this package keeps Codex as itself: its own binary, its own tool
loop, its own session. The cost of that honesty is that "switching" is a
real engine change the operator will notice, not a seamless swap — and the
point of this package is to say exactly how much that costs, not to hide
it.

## Status

`draft` — written 2026-08-09 on the operator's explicit request, deliberately
as thorough as the available evidence supports, with weak points named
for independent review rather than smoothed over.
See [review-focus.md](review-focus.md) for the specific list.

## Established Facts

| Question | Answer | Source |
|---|---|---|
| Is there a mechanism today for a project to run something other than `claude`? | No. `scripts/run-cli.sh` launches exactly `claude --dangerously-load-development-channels server:helyx-channel`, unconditionally | `scripts/run-cli.sh:159` |
| Is the tmux invariant (one window/pane = one project's CLI process) hard? | Yes, and load-bearing for `SessionManager`, `tmux-watchdog.ts`, `scripts/supervisor.ts`, `scripts/admin-daemon.ts` — see `docs/requirements/codex-provider-2026-08-09/README.md` §"What is different" for the citations; unchanged by this package | `cli.ts:1473-1504`, `scripts/tmux-watchdog.ts:138` |
| How does helyx-channel reach a Claude Code session? | A single MCP server registered globally in `~/.claude.json` via `claude mcp add --transport http`, referenced by the alias `server:helyx-channel` at launch; project identity travels as the `X-Helyx-Project` header, built from `HELYX_PROJECT_PATH` | `cli.ts:1948`, `scripts/run-cli.sh:22` |
| Does Codex have an equivalent registration surface? | Yes — `codex mcp add/list/get/remove` is a first-class subcommand (`codex-cli 0.147.0`, verified `codex mcp --help` 2026-08-09). Whether it accepts the same HTTP transport and custom-header project identification is **not yet tested end to end** | see [review-focus.md](review-focus.md) R2 |
| Does Codex have a real interactive mode, not just `exec`? | Yes — bare `codex` (no subcommand) is a TUI, directly analogous to `claude`. Confirmed via `codex --help`, 2026-08-09 | — |
| Does Codex have its own session continuity? | Yes — `codex resume --last` continues Codex's own most recent interactive session natively. This is same-engine continuity, not cross-engine | — |
| Is there already a mechanism for a fresh CLI process to receive prior context? | Yes — `channel/poller.ts`'s session-context injection: on a session's first delivered message after a process restart, a prior summary (or recent raw history) is prepended. Built for Claude→Claude restarts; §"Context Handoff" below is about whether it also covers Claude→Codex and Codex→Claude | `docs/requirements/session-context-injection.md` ("Implemented — verified against the code on 2026-07-31") |
| Is there already a hook for "Claude just hit a usage limit"? | Yes — `channel/status.ts`'s `noteApiError()`, called when the channel sees a synthetic `isApiErrorMessage: true` entry Claude Code itself writes into its own transcript, writes a row via `services/limit-marker.ts`'s `startLimit()`. Today this only makes `LimitHold` pause delivery until the marker expires | `services/limit-marker.ts:1-22, 197-238`, `channel/status.ts:1758-1820` |
| Is there an equivalent for "Codex just hit its usage limit"? | **No.** `noteApiError` reads a shape specific to Claude Code's own transcript format. Codex has no transcript in that format at all. This asymmetry is real and is §R1 in [review-focus.md](review-focus.md) | — |

## What This Package Is Not

- Not the proxy-behind-`claude` design (`docs/requirements/codex-provider-2026-08-09`) — that package is a sibling alternative, spiked 2026-08-09 and left at `draft` with Option A (Codex as delegated sub-agent behind `claude`) as its only viable path. Building both at once is not proposed; they solve the same problem two structurally different ways and share almost no code.
- Not an automatic switch. Every design here defaults to a Telegram-triggered switch the operator initiates (or explicitly confirms via an inline button when a limit fires) — see `prd.md` §Requirements and the reasoning already recorded in [[architecture_codex_review_vs_session_engine]] against building automatic switching first.
- Not a claim that Codex "feels the same" as Claude Code mid-conversation. It does not, and cannot: different tool set, different permission model, different personality. This package is honest about that in `prd.md` §Risks rather than promising parity.

## Document Index

| File | Contents |
|---|---|
| [README.md](README.md) | This file |
| [prd.md](prd.md) | Problem, goal, requirements, risks, recommendation |
| [specification.md](specification.md) | DB schema, run-cli.sh design, MCP wiring, health monitoring, context-handoff reuse, Telegram command surface, acceptance criteria |
| [review-focus.md](review-focus.md) | Every claim in this package the operator asked to be flagged for independent, adversarial review by other sub-agents/models — named, not buried |

## Related Modules

- `scripts/run-cli.sh`, `cli.ts` (`startWindow`, `ensureAdminDaemon`/`ensureOllamaProxy` pattern), `scripts/tmux-watchdog.ts`, `scripts/supervisor.ts` — the process-lifecycle layer this package must extend without breaking the one-process-per-window invariant.
- `bot/providers/presets.ts`, `bot/commands/providers.ts`, `services/provider-service.ts` — the closest existing UX precedent (per-project selection from Telegram), reused as a pattern, not as code (a provider and an engine are orthogonal: `provider_id`/`model` only mean anything when `engine = 'claude'`).
- `channel/poller.ts`, `docs/requirements/session-context-injection.md` — the reusable context-continuity mechanism this package leans on rather than reinventing.
- `services/limit-marker.ts`, `channel/status.ts` (`noteApiError`) — the existing Claude-limit trigger this package hooks into for the Claude→Codex direction; has no counterpart for Codex→Claude (see above).
- `bot/commands/codex.ts`, `services/reviewer-service.ts` (`classifyCodexFailure`) — existing Codex login and error-classification code this package reuses rather than reimplements.
- `docs/requirements/codex-provider-2026-08-09/` — the sibling/alternative package; its spike findings about Codex's agentic, non-stateless nature are relevant background but do not block this design, since here Codex being a full agent is the point, not a problem to work around.

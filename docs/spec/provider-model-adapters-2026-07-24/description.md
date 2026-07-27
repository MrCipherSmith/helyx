# Description

## Problem

helyx is hardwired to Anthropic-hosted Claude. Every project runs
`claude --dangerously-load-development-channels server:helyx-channel` against
Anthropic's default endpoint with the single `ANTHROPIC_API_KEY` from helyx
`.env`. There is no way to:

- run a project on a cheaper / alternative model (GLM, Kimi, DeepSeek, …);
- run a project on a different model tier of Anthropic itself (Opus vs Sonnet vs
  Haiku) per project;
- change either of these without editing files on the host.

This is a real cost and resilience limitation and blocks the broader "reduce
Claude lock-in" direction.

## Expected outcome

1. **Providers are a first-class, Telegram-managed entity.** The operator can
   register a provider (name, Anthropic-compatible base URL, auth token, auth
   scheme, offered models) from the Telegram command-menu, and remove it.
   Presets (GLM/Z.ai, Kimi/Moonshot, DeepSeek, OpenRouter) prefill the base URL.

2. **Per-project selection of provider + model** at `/project_add` time via
   inline-keyboard pickers (provider → model). Default = Anthropic (no override).

3. **On-the-fly change from the command-menu** for an already-added project:
   pick project → change provider and/or model → the project restarts on the new
   config automatically. Project identity, forum topic, history and `project_id`
   survive the restart (they live in the DB; verified — see `context.md`).

4. The change is delivered by **restarting the existing Claude Code CLI with new
   env** (`proj_stop` + `proj_start`). No new agent runtime, no new adapter
   process, no change to helyx-channel, tmux, or the watchdog.

## Out of scope (explicitly)

- Driving **other CLI agents** (opencode / codex / grok / antigravity). That is a
  separate, larger effort (`AgentAdapter`). This package only swaps the
  provider/model *behind the existing Claude Code CLI* via `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_MODEL`. The `sessions.cli_type` / `cli_config` columns already in the
  schema are left as the future seam but are not exercised here beyond recording
  `cli_type='claude'`.
- Per-message / mid-session model switching. Granularity is per-project;
  a change triggers a session restart.
- Bedrock / Vertex first-class backends (`CLAUDE_CODE_USE_BEDROCK/VERTEX`). Could
  be modeled later as provider `auth_scheme` variants; not in this package.
- Prompt-caching / web-search parity on third-party endpoints (may be absent;
  acceptable).

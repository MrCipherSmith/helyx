# Context

## Verified in this session (empirical, not assumed)

| # | Finding | Evidence |
|---|---------|----------|
| V1 | **helyx-channel dev-channel attaches fine behind a non-Anthropic `ANTHROPIC_BASE_URL`.** The v2.1.196+ "Remote Control disabled behind custom base URL" gating does **not** disable development channels. | In-situ run via real `run-cli.sh` against a local Anthropic-compatible mock (`localhost:8899`): after wiping all sessions, a fresh `sessions` row appeared — `status=active`, `source=remote`, real MCP `client_id` UUID (`024f790a-…`), `cli_type=claude`, `last_active`/`pane_snapshot_at` ticking. TUI showed `mock-model`. |
| V2 | **Provider/model injection via project `.env` works end-to-end** through the real `run-cli.sh` → claude launch. | Same run; `.env` held `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL`; claude ran on the mock. |
| V3 | **`-p` (non-interactive) mode does NOT load dev-channels.** Only the interactive TUI does. helyx already runs interactive. | Control `-p` runs never spawned/attached a channel; interactive runs did. |
| V4 | **Auth is validated early.** A bogus token against real Anthropic → immediate `401` before the channel loads. A real provider needs a *valid* key or the session won't come up. | dummy-key control run exited `401`; mock (returns 200) let the TUI load as generic "Welcome back!" via token auth. |
| V5 | **`ANTHROPIC_API_KEY` leak risk.** helyx `.env` sets `ANTHROPIC_API_KEY`; `run-cli.sh:load_env` exports vars only "if not already set", so a project `.env` **cannot** override/clear it. With a third-party base URL, that real Anthropic key is sent (as `x-api-key`) to the third party. | `grep ANTHROPIC helyx/.env` → `ANTHROPIC_API_KEY` present; `run-cli.sh:37` `[[ -z "${!key}" ]] && export`. |
| V6 | **Model-only switch within Anthropic is zero-risk** (endpoint stays Anthropic, gating never triggers). Provider switch is the only path that needed V1 proof. | Docs + V1. |
| V7 | **Schema already has multi-CLI scaffolding.** `sessions.cli_type` default `'claude'`, `sessions.cli_config` jsonb default `'{}'`. | `information_schema.columns` on `sessions`. |

## Claude Code config facts (from official docs, verified against v2.1.198)

- Provider endpoint: `ANTHROPIC_BASE_URL` (must speak Anthropic Messages API).
  Auth: `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`; `ANTHROPIC_API_KEY` →
  `x-api-key`.
- Model: `ANTHROPIC_MODEL` (alias or full id). Precedence: `/model` > `--model` >
  `ANTHROPIC_MODEL` > settings.json `model`.
- Third-party endpoints: set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (else
  beta fields like `context_management` can 400). Model-id validation is skipped
  behind a custom base URL.
- Installed version here: **claude 2.1.198**.

## Affected code map (from this session's reads)

### Launch / lifecycle
- `scripts/run-cli.sh` — loads helyx `.env` then project `.env` (`load_env`,
  "only if unset"), then `claude --dangerously-load-development-channels
  server:helyx-channel`. Already has `DATABASE_URL` + `psql` (escalation path,
  line ~81). **This is the env-injection point.**
- `scripts/admin-daemon.ts` `case "proj_start"` (~L243) — creates the tmux window
  and `send-keys "run-cli.sh <path>"`. Payload carries `{project_id, path, name,
  tmux_session_name}` in `admin_commands`. **Secrets must NOT be added here** (the
  table/payload is logged).

### Project registration + start/stop
- `bot/commands/project-add.ts` — `/project_add`; `setPendingInput` pattern for
  path entry; `injectBotRules`; forum topic creation.
- `services/project-service.ts` — `create()` (INSERT projects + remote session),
  `start()`/`stop()` → `action()` enqueues `admin_commands`, `enqueueRestart()`.
- `bot/commands/projects.ts` — projects list + start/stop buttons (callback map).
- `bot/commands/menu.ts` (~L261) — menu callback router (e.g. `project_add`).
- `main.ts` (~L60/L74) — Telegram command registration (`setMyCommands`).

### Schema
- `memory/db.ts` — numbered migrations (last relevant: v16 added
  `permission_requests.tmux_target`). New migration goes here.
- `projects` table: `(id, name, path, tmux_session_name, forum_topic_id,
  created_at)`, unique on `path`.
- `sessions` table: NOT-NULL `client_id` (channel-provided), `status` default
  `active`, `cli_type` default `claude`, `cli_config` jsonb, `source`, plus
  `project_id`, `project_path`, `last_active`, `pane_snapshot`.

## Related design threads (not blocking)

- Broader multi-CLI capability matrix and `AgentAdapter` seam live in the earlier
  brainstorm; this package is the cheap "Phase 0 + provider layer" slice of it.

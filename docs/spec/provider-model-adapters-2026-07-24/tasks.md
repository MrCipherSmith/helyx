# Tasks

Grouped by kind (matches flow-orchestrator worker routing: schema→backend→
launch→tg→test→docs). Each task lists the ACn it satisfies. Keep atomic.

## Schema

### T-SCHEMA-1 — `providers` table + `projects` columns (kind: implement)
- Add a numbered migration in `memory/db.ts` (follow existing v-number pattern).
- Create `providers` (see `plan.md` DDL) and add `projects.provider_id` (FK, ON
  DELETE SET NULL) + `projects.model`.
- Idempotent (`IF NOT EXISTS`), runs on bot start.
- Satisfies: AC-1.

## Backend

### T-BE-1 — `providerService` (kind: implement)
- New `services/provider-service.ts`: `create/list/get/remove`, and decide the
  Anthropic-default representation (NULL provider_id vs sentinel row) — document
  the choice inline.
- Validate `base_url` is http(s); `auth_scheme ∈ {bearer, api_key}`.
- Satisfies: AC-1, AC-2.

### T-BE-2 — project provider/model mutators (kind: implement)
- Extend `services/project-service.ts`: `setProvider(projectId, providerId|null)`,
  `setModel(projectId, model|null)`, and `restart(projectId, reason)` wrapping the
  existing `enqueueRestart` (proj_stop+proj_start).
- Satisfies: AC-3, AC-4.

### T-BE-3 — provider presets (kind: implement)
- `bot/providers/presets.ts`: GLM/Z.ai, Kimi/Moonshot, DeepSeek, OpenRouter +
  Custom — name, base_url, auth_scheme, suggested models.
- Satisfies: AC-2.

## Launch (host)

### T-LAUNCH-1 — resolve provider config in `run-cli.sh` (kind: implement)
- After `.env` loads, query DB by `$PROJECT_DIR` (psql + `DATABASE_URL`), export
  `ANTHROPIC_BASE_URL` / (`ANTHROPIC_AUTH_TOKEN`|`ANTHROPIC_API_KEY`) /
  `ANTHROPIC_MODEL` / `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` per `plan.md`.
- Safe path handling (already regex-validated upstream; still quote).
- Satisfies: AC-4, AC-5.

### T-LAUNCH-2 — ★ clear `ANTHROPIC_API_KEY` for third-party providers (kind: implement)
- When a `base_url` is resolved, `unset ANTHROPIC_API_KEY` before exporting the
  provider auth. Add a regression test/asserted comment referencing V5.
- **Security-critical.** Satisfies: AC-6.

## Telegram (command-menu)

### T-TG-1 — provider management commands (kind: implement)
- `/providers` (list + remove + add), add-flow via `setPendingInput`, presets.
- Register commands in `main.ts` `setMyCommands`; route in `bot/commands/menu.ts`.
- Satisfies: AC-2.

### T-TG-2 — provider+model picker at `/project_add` (kind: implement)
- Extend `bot/commands/project-add.ts`: after path, inline-keyboard provider
  picker → model picker → persist. "Default (Claude)" always first.
- Satisfies: AC-3.

### T-TG-3 — on-the-fly change from projects menu (kind: implement) ★ headline
- In `bot/commands/projects.ts`, add per-project "⚙️" → "Change provider" /
  "Change model" submenus (callback scheme in `plan.md`). On select: write DB +
  `projectService.restart()` + confirm message.
- Satisfies: AC-4, AC-8.

### T-TG-4 — bad-key / restart-loop feedback (kind: implement)
- When a provider-configured project hits the run-cli restart-escalation (V4),
  the existing Telegram escalation should name the provider and suggest checking
  the key. Small message tweak; reuse existing escalation path.
- Satisfies: AC-9.

## Tests

### T-TEST-1 — run-cli injection unit test (kind: test)
- Extract the env-resolution into a testable shell function or a tiny helper;
  assert: base_url set → `ANTHROPIC_API_KEY` unset + correct auth var; model-only
  → key preserved; none → unchanged. (Mirror `tests/unit/tmux-watchdog.test.ts`
  style for pure functions.)
- Satisfies: AC-5, AC-6.

### T-TEST-2 — provider/project service tests (kind: test)
- CRUD + `setProvider/setModel/restart` (restart enqueues exactly one proj_start;
  dedupe honored).
- Satisfies: AC-1, AC-3, AC-4.

### T-TEST-3 — end-to-end mock attach (kind: test, manual/integration)
- Reproduce the verified in-situ path against a local Anthropic mock: register
  provider, set on a throwaway project, restart, assert a fresh `active`/`remote`
  session with a real `client_id` appears. (Script skeleton exists from the
  verification session.)
- Satisfies: AC-8.

## Docs

### T-DOCS-1 — operator + dev docs (kind: docs)
- `docs/` page: how to add a provider, switch provider/model, the key-leak note.
- Update `CLAUDE.md`/architecture doc: provider/model resolution in run-cli.sh;
  note `sessions.cli_type/cli_config` reserved for future multi-CLI.
- Satisfies: AC-10.

## Suggested order
T-SCHEMA-1 → T-BE-1/3 → T-LAUNCH-1/2 (+T-TEST-1) → T-TG-1 → T-TG-2 → T-TG-3
(+T-TEST-2/3) → T-TG-4 → T-DOCS-1.

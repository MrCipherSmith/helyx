# Plan

## Chosen approach

Keep the existing Claude Code CLI and helyx-channel untouched. Model the
provider/model choice as **DB state on the project**, resolved into **env vars at
launch inside `run-cli.sh`**. Telegram is a thin CRUD + picker UI over that
state. An on-the-fly change is a DB write followed by the existing
`proj_stop`+`proj_start` restart — proven safe because project/topic/session
identity is DB-backed (context V1).

Rejected alternatives:
- Secrets in `admin_commands.payload` or tmux args → logged / visible. **No.**
- Project `.env` files as the source of truth → not Telegram-manageable, secrets
  scattered on disk, and cannot clear `ANTHROPIC_API_KEY` (V5). Used only as an
  internal implementation detail if at all; DB is the source of truth.
- `.claude/settings.json` per project → needs trust-wizard, worse than env.

## Data model (migration in `memory/db.ts`)

```sql
-- providers: operator-registered Anthropic-compatible backends
CREATE TABLE IF NOT EXISTS providers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,             -- "GLM (Z.ai)"
  base_url    TEXT NOT NULL,                    -- https://api.z.ai/api/anthropic
  auth_token  TEXT NOT NULL,                    -- secret (bearer or api-key value)
  auth_scheme TEXT NOT NULL DEFAULT 'bearer',   -- 'bearer' | 'api_key'
  models      JSONB NOT NULL DEFAULT '[]',      -- [{"id":"glm-5.2","label":"GLM 5.2"}]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-project selection; NULL provider_id = default Anthropic (use helyx key)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS provider_id INT
  REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS model TEXT;  -- alias or full id; NULL = provider/Claude default
```

- `provider_id IS NULL` → Anthropic default endpoint + helyx `ANTHROPIC_API_KEY`.
  `model` may still be set (Anthropic model tier switch — zero-risk, V6).
- `provider_id` set → third-party endpoint; `model` should be set to one of the
  provider's `models`.
- Anthropic itself may optionally be represented as a normal `providers` row with
  a sentinel (e.g. `auth_scheme='anthropic_default'`, empty `base_url`) so the
  picker is uniform; either representation is acceptable — pick one in T-BE-1.

## Launch injection (`scripts/run-cli.sh`) — the core change

After the existing `.env` loads, before launching claude, resolve provider config
from the DB by project path (psql + `DATABASE_URL` already available) and export:

```sh
# pseudo — see T-LAUNCH-1/2
row=$(psql "$DATABASE_URL" -At -F'|' -c "
  SELECT COALESCE(pv.base_url,''), COALESCE(pv.auth_token,''),
         COALESCE(pv.auth_scheme,''), COALESCE(pr.model,'')
  FROM projects pr LEFT JOIN providers pv ON pv.id = pr.provider_id
  WHERE pr.path = '$PROJECT_DIR'")
base_url=…; token=…; scheme=…; model=…

if [ -n "$base_url" ]; then           # third-party provider
  unset ANTHROPIC_API_KEY             # ★ SECURITY (V5) — never leak Anthropic key
  export ANTHROPIC_BASE_URL="$base_url"
  if [ "$scheme" = "api_key" ]; then export ANTHROPIC_API_KEY="$token"
  else                                export ANTHROPIC_AUTH_TOKEN="$token"; fi
  export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
fi
[ -n "$model" ] && export ANTHROPIC_MODEL="$model"
```

Notes:
- Use parameterized/escaped path (path already validated `^[a-zA-Z0-9/_.-]+$` in
  admin-daemon; still avoid injection — quote or use `-v`).
- Token never leaves the host process env; not logged, not in tmux args.
- Model-only (no base_url) path leaves Anthropic auth untouched.

## Telegram UX (command-menu — change BOTH provider and model)

### Provider management
- `/providers` → list with remove buttons; "➕ Add provider" button.
- Add flow (reuse `setPendingInput`): pick preset (GLM/Kimi/DeepSeek/OpenRouter/
  Custom) → base URL prefilled/entered → token entered → models entered
  (comma list or fetched). Persist via `providerService.create()`.
- Presets table lives in code (`bot/providers/presets.ts`): name + base_url +
  auth_scheme + suggested models.

### Per-project selection (add-time)
- Extend `project-add.ts`: after path validation, show provider inline keyboard
  (`[Default (Claude)] [GLM] [Kimi] …`) → then model inline keyboard for the
  chosen provider → save `projects.provider_id`/`model`.

### On-the-fly change (headline requirement)
- From the projects menu (`bot/commands/projects.ts`), each project row gets a
  "⚙️" action → submenu: **Change provider** / **Change model**.
- Selecting writes `projects.provider_id`/`model`, then calls
  `projectService.restart()` (= `enqueueRestart`, i.e. `proj_stop`+`proj_start`).
- Confirm to the user: "🔄 <project> перезапускается на <provider>/<model>".
- Because identity is DB-backed (V1), the forum topic and history are preserved;
  the channel re-attaches under the new endpoint (V1 proven).

### Callback-data scheme (namespaced, keep under Telegram's 64-byte limit)
- `prov:add`, `prov:rm:<id>`, `prov:preset:<key>`
- `pmsel:<projectId>:prov:<providerId|def>` (select provider for project)
- `pmsel:<projectId>:model:<providerId|def>:<modelIdx>` (select model)
- On-the-fly submenu: `pmchg:<projectId>:prov` / `pmchg:<projectId>:model`

## Precedence & defaults
- Resolution: project `provider_id`/`model` → env in run-cli.sh → Claude Code
  precedence (`ANTHROPIC_MODEL` beats settings; `/model` in-session still wins but
  we don't set it).
- No selection → today's behavior exactly (Anthropic default, helyx key).

## Risk register
| Risk | Mitigation |
|------|-----------|
| Anthropic key leak to third party (V5) | `unset ANTHROPIC_API_KEY` in run-cli.sh when base_url set — AC-6, T-LAUNCH-2 |
| Invalid provider key → session won't start (V4) | Surface run-cli 401/restart-loop via existing escalation + watchdog crash alert; T-TG-4 shows a hint |
| Secret exposure | tokens only in `providers.auth_token` (DB) + host env; never payload/tmux/logs — AC-7 |
| 400s on third-party betas | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` — AC-5 |
| Restart races | reuse idempotent `enqueueRestart` (already dedupes pending proj_start) |

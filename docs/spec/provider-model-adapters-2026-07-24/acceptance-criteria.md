# Acceptance Criteria

Each `ACn` is independently verifiable. "Verified by" names the check.

- **AC-1 — Provider persistence.** A `providers` table exists (migration applied
  on bot start) and `projects` has `provider_id` (FK) + `model`. Creating a
  provider persists all fields incl. `auth_scheme` and `models`.
  *Verified by:* T-TEST-2; schema inspection.

- **AC-2 — Register/remove providers from Telegram.** `/providers` lists
  providers; the add-flow (with GLM/Kimi/DeepSeek/OpenRouter presets) creates one;
  remove deletes it. Preset selection prefills the base URL.
  *Verified by:* manual Telegram run; T-TEST-2.

- **AC-3 — Select provider + model at add-time.** `/project_add` presents a
  provider picker then a model picker; the choice is stored on the project;
  "Default (Claude)" yields `provider_id=NULL`.
  *Verified by:* manual; T-TEST-2.

- **AC-4 — Change provider AND model on the fly from the command-menu.** For an
  already-added, running project, the operator can change the provider and/or the
  model from the menu; the project restarts and comes back on the new config;
  forum topic, history and `project_id` are unchanged.
  *Verified by:* T-TG-3 manual; T-TEST-3.

- **AC-5 — Third-party launch correctness.** With a provider set, the launched
  claude has `ANTHROPIC_BASE_URL` = provider base_url, the correct auth var per
  `auth_scheme`, `ANTHROPIC_MODEL` = selected model, and
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`.
  *Verified by:* T-TEST-1; pane shows the selected model.

- **AC-6 — ★ No Anthropic key leak.** When a third-party provider is active,
  `ANTHROPIC_API_KEY` is **unset** in the launched claude's environment (the real
  Anthropic key is never sent to the third-party endpoint).
  *Verified by:* T-TEST-1 asserts unset; process-env inspection of a running
  third-party session shows no `ANTHROPIC_API_KEY`.

- **AC-7 — Secret hygiene.** Provider tokens appear only in `providers.auth_token`
  and the host process env at launch — never in `admin_commands.payload`, tmux
  command args, or logs.
  *Verified by:* grep of `admin_commands` rows + tmux pane + logs during a run.

- **AC-8 — Channel survives provider switch.** After switching a project to a
  third-party provider, a fresh `sessions` row is `status=active`, `source=remote`
  with a real MCP `client_id`, and `reply`/`update_status` work in that project's
  topic.
  *Verified by:* T-TEST-3 (mirrors the verified in-situ mock test).

- **AC-9 — Bad-key feedback.** A project configured with an invalid provider key
  does not silently hang: the operator gets a Telegram message identifying the
  project/provider (via the existing run-cli escalation path).
  *Verified by:* manual with a deliberately-wrong key.

- **AC-10 — Docs.** Operator doc (add provider / switch) and dev doc (run-cli
  resolution + key-leak rule + reserved `cli_type/cli_config`) exist.
  *Verified by:* review.

- **AC-0 — No regression for default projects.** A project with no
  provider/model selected launches exactly as today (Anthropic default endpoint,
  helyx `ANTHROPIC_API_KEY`, default model), channel attaches.
  *Verified by:* start an unconfigured project; unchanged behavior.

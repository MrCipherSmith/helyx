# Module Reference

This document is a quick-reference for developers working on specific parts of the Helyx codebase. Each section covers one module: purpose, entry point, key files, public API/exports, environment variables, how to develop/test it, and inter-module dependencies.

---

## Table of Contents

- [bot](#bot)
- [channel](#channel)
- [mcp](#mcp)
- [sessions](#sessions)
- [memory](#memory)
- [services](#services)
- [adapters](#adapters)
- [orchestrator](#orchestrator)
- [utils](#utils)
- [scripts](#scripts)
- [dashboard](#dashboard)

---

## bot

**Purpose.** The Telegram-facing command layer. Translates all user interactions (commands, text, media, polls, callback queries) into either database queue entries consumed by the channel adapter (CLI mode) or direct Anthropic API calls (standalone mode).

**Entry point.** `bot/bot.ts` → `createBot()`; handlers registered in `bot/handlers.ts` → `registerHandlers()`.

### Key Files

| File | Responsibility |
|---|---|
| `bot/bot.ts` | Creates grammy Bot instance, attaches access middleware, calls `registerHandlers()`, sets WebApp menu button |
| `bot/handlers.ts` | Registers all grammy update listeners; owns `pendingInput` / `pendingToolInput` maps |
| `bot/text-handler.ts` | Catch-all text handler; pending-input / pending-tool dispatch, forum-block, `routeMessage` dispatch |
| `bot/callbacks.ts` | Prefix-based inline-keyboard router; dynamic-imports less-common handlers |
| `bot/media.ts` | Photo, document, voice, video, video-note, sticker pipelines; voice → `transcribe` → queue |
| `bot/streaming.ts` | Streaming Anthropic API responses to Telegram (standalone mode) |
| `bot/access.ts` | `accessMiddleware` — whitelist gate before every update |
| `bot/forum-cache.ts` | Lazy in-memory cache of `forum_chat_id` from `bot_config` table |
| `bot/topic-queue.ts` | Per-topic serial queue — `enqueueForTopic(key, task)` |
| `bot/switch-cache.ts` | 60-minute context cache injected on first message after `/switch` |
| `bot/commands/session.ts` | `/start`, `/help`, `/sessions`, `/switch`, `/session`, `/rename`, `/remove`, `/cleanup`, `/standalone` |
| `bot/commands/memory.ts` | `/clear`, `/summarize`, `/remember`, `/recall`, `/memories`, `/forget` |
| `bot/commands/admin.ts` | `/status`, `/stats`, `/logs`, `/pending`, `/permission_stats`, `/tools`, `/skills`, `/commands`, `/hooks`, `/rules` |
| `bot/commands/forum.ts` | `/forum_setup`, `/forum_sync`, `/forum_clean`, `/forum_hub`, `/topic_rename`, `/topic_close`, `/topic_reopen` |
| `bot/commands/codex.ts` | `/codex_setup`, `/codex_status`, `/codex_review` |
| `bot/commands/system.ts` | `/system` — admin-only start/stop/restart inline panel |
| `bot/commands/add.ts` | `/add` — quick project registration shortcut |
| `bot/commands/btw.ts` | `/btw` — asks the active Claude Code session "what are you doing right now?" via the transcript overlay |
| `bot/commands/interrupt.ts` | `/interrupt` — sends Escape to the tmux pane via `admin_commands` |
| `bot/commands/memory-export.ts` | `/memory_export`, `/memory_import` |
| `bot/commands/menu.ts` | `/menu` — two-level inline command navigator, and its callback routing |
| `bot/commands/model.ts` | `/model` + `set_model:` callbacks |
| `bot/commands/monitor.ts` | `/monitor` — process/Docker health panel |
| `bot/commands/now.ts` | `/now` — snapshot of what the active session is doing right now, from its transcript |
| `bot/commands/prepare-restart.ts` | `/prepare_restart` — snapshots context in all active sessions before a redeploy |
| `bot/commands/project-add.ts` | `/project_add` — registers a project, maps host↔container paths (`toContainerPath()`) |
| `bot/commands/project-facts.ts` | `/project_facts` — shows and force-rescans scanned project-knowledge memories |
| `bot/commands/projects.ts` | `/projects` + `proj:` callbacks — project registry list/start/stop |
| `bot/commands/providers.ts` | `/providers` — register/list/remove Anthropic-compatible provider backends; per-project provider/model picker callbacks |
| `bot/commands/quickstart.ts` | `/quickstart` — guided setup steps (forum supergroup, whitelist, first project) |
| `bot/commands/remote-control.ts` | `/remote_control` + `rc:` callbacks |
| `bot/commands/resume.ts` | `/resume` — restores the last session summary into the active Claude session |
| `bot/commands/reviewers.ts` | `/reviewers` — manage the independent code reviewers (`add`, `remove`, `status`) |
| `bot/commands/supervisor-actions.ts` | Supervisor-topic inline-button callbacks (`sup:restart_session`, `sup:ignore`, …) |
| `bot/commands/tmux-actions.ts` | `tmux:ACTION:PROJECT` callbacks — Interrupt / Force close buttons from the watchdog |
| `bot/commands/tmux-log.ts` | `/tmux_log` — tmux session lifecycle log viewer |

### Public API / Exports

- `createBot(sql, sessionManager, …) → Bot` — returns a configured grammy `Bot` ready to start polling/webhook.
- `enqueueToolCommand(ctx, type, name, args?)` — exported from `text-handler.ts`; inserts a tool invocation into `message_queue`.
- `invalidateForumCache()` — exported from `forum-cache.ts`; call after any forum config change.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | grammy Bot token |
| `ALLOWED_USERS` | `""` | Comma-separated user IDs whitelist |
| `ALLOW_ALL_USERS` | `false` | Bypass whitelist (dev only) |
| `TELEGRAM_TRANSPORT` | `polling` | `polling` or `webhook` |
| `TELEGRAM_WEBHOOK_URL` | `""` | WebApp menu button origin |
| `TELEGRAM_WEBHOOK_SECRET` | `""` | Webhook secret |
| `TELEGRAM_WEBHOOK_PATH` | `/telegram/webhook` | Webhook path |
| `TELEGRAM_CHAT_ID` | — | Admin chat ID (for `/system`, supervisor) |
| `SUPERVISOR_TOPIC_ID` | `0` | Forum topic for supervisor intercepts |
| `DOWNLOADS_DIR` | `/app/downloads` | Downloaded media storage |
| `HOST_DOWNLOADS_DIR` | — | Host-side path for media (Claude Code access) |
| `HOST_CLAUDE_CONFIG` | `/host-claude-config` | Host `~/.claude` mount for auto-approve writes |
| `GROQ_API_KEY` | `""` | Voice transcription (Whisper via Groq) |
| `WHISPER_URL` | `http://localhost:9000` | Local Whisper endpoint |
| `TTS_PROVIDER` | `auto` | TTS provider for voice replies |

### How to Develop

Run the bot in isolation with `bun main.ts` (Docker-side) or `bun run dev` if a dev script exists. To test without real Telegram, set `TELEGRAM_TRANSPORT=polling` and use a test bot token. Command handlers live in `bot/commands/`; adding a command requires: (1) writing the handler function, (2) registering `b.command("name", handler)` in `handlers.ts`.

For media/voice changes, edit `bot/media.ts` and restart the host `channel.ts` subprocess (TTS runs on host).

### Dependencies on Other Modules

- `sessions/router.ts` — `routeMessage()` for every text/media message
- `services/` — all service facades (memory, forum, session, project)
- `memory/db.ts` — SQL client `sql`
- `utils/transcribe.ts` — voice transcription
- `utils/tts.ts` — voice replies (via channel)
- `utils/tools-reader.ts` — skill/command/hook lists for menus

---

## channel

**Purpose.** stdio MCP server running on the **host machine** (not in Docker) that Claude Code connects to. Bridges Claude Code tool calls → Telegram and Telegram user messages → Claude Code via MCP notifications. Also owns permission gating, live status messages, and TTS.

**Entry point.** `channel.ts` (root shim, loads `.env`) → `channel/index.ts` (bootstraps all subsystems).

### Key Files

| File | Responsibility |
|---|---|
| `channel/index.ts` | Bootstrap: validates env, instantiates subsystems, calls `main()` |
| `channel/session.ts` | `SessionManager` — TTL-lease-based session ownership; heartbeat; idle timer |
| `channel/status.ts` | `StatusManager` — live Telegram status messages; spinner; response guard |
| `channel/permissions.ts` | `PermissionHandler` — intercepts Claude's permission notifications; polls DB for user answer |
| `channel/poller.ts` | `MessageQueuePoller` — LISTEN/NOTIFY + fallback polling; delivers messages to Claude Code |
| `channel/tools.ts` | `registerTools()` — all 18 MCP tool handlers (reply, remember, recall, send_poll, propose_skill, …) |
| `channel/skill-evaluator.ts` | `SkillEvaluator` — scores messages against `goodai-base/rules.json`; injects skill hints |
| `channel/recovery.ts` | Startup recovery: stale status messages, stale voice messages, pending replies |
| `channel/telegram.ts` | Leaf HTTP layer for Telegram API (sendMessage, editMessage, setReaction, sendPoll) |

### Public API / Exports

No external consumers import from `channel/` — it is a self-contained process. The MCP tool surface (18 tools) is what Claude Code sees.

### Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection |
| `BOT_API_URL` | No | `http://localhost:3847` | Docker-side MCP HTTP server |
| `TELEGRAM_BOT_TOKEN` | No | — | Sending Telegram messages |
| `CHANNEL_SOURCE` | No | — | `remote` or `local`; controls session strategy |
| `IDLE_TIMEOUT_MS` | No | `900000` | Idle auto-summarize timer (ms) |
| `OLLAMA_URL` | No | `http://localhost:11434` | pgvector embeddings |
| `EMBEDDING_MODEL` | No | `nomic-embed-text` | Embedding model |
| `TTS_PROVIDER` | No | `auto` | TTS synthesis provider |

### How to Develop

The channel runs outside Docker: `bun channel.ts`. Restart it (not Docker) to pick up changes to `channel/` or `utils/tts.ts`. It reads its own `.env` from the project root. For local testing without Claude Code, point `CHANNEL_SOURCE=local` and simulate MCP tool calls manually.

To add a new MCP tool: add the handler inside `channel/tools.ts` → `registerTools()`, mirror the schema in `mcp/tools.ts` for the Docker-side server if needed.

### Dependencies on Other Modules

- `memory/db.ts` — SQL client; `memory/long-term.ts`, `memory/embeddings.ts`
- `utils/tts.ts` — voice synthesis
- `utils/skill-evaluator.ts` (via internal `skill-evaluator.ts`)
- `utils/skill-handlers.ts`, `utils/skill-distiller.ts`, `utils/curator.ts`
- `sessions/` — indirectly via DB tables (`sessions`, `message_queue`, `permission_requests`)

---

## mcp

**Purpose.** HTTP MCP server running **inside Docker** on port 3847. Receives Claude Code tool calls over StreamableHTTP/SSE, dispatches them to Telegram/DB, and also serves the dashboard REST API, static assets, and (optionally) the Telegram webhook.

**Entry point.** `mcp/server.ts` → `startMcpHttpServer(bot)`.

### Key Files

| File | Responsibility |
|---|---|
| `mcp/server.ts` | HTTP server factory; routing: `/mcp`, `/api/*`, static files, optional webhook |
| `mcp/tools.ts` | Tool schema definitions (JSON Schema) + `executeTool()` dispatch for all 19 MCP tools |
| `mcp/bridge.ts` | In-process registry: MCP transport UUID → McpServer; push-notification sender |
| `mcp/dashboard-api.ts` | All REST route handlers; static file serving with cache headers and path-traversal protection |
| `mcp/notification-broadcaster.ts` | SSE client registry; `broadcast(event, data)` to all connected dashboard tabs |
| `mcp/pending-expects.ts` | Pre-registration queue: coordinates `channel.ts → sessionManager` linking on connect |

### Public API / Exports

- `startMcpHttpServer(bot) → { server, shutdown }` — starts the HTTP server, returns handle.
- `broadcast(event, data)` from `notification-broadcaster.ts` — used throughout the codebase for real-time dashboard updates.
- `notifySession(clientId, notification)` from `bridge.ts` — sends MCP push-notification to a specific Claude Code session.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3847` | HTTP server port |
| `JWT_SECRET` | derived from `TELEGRAM_BOT_TOKEN` | Dashboard JWT signing |
| `TELEGRAM_BOT_TOKEN` | required | Telegram Login Widget verification |
| `TELEGRAM_TRANSPORT` | `polling` | Set to `webhook` to enable webhook endpoint |
| `TELEGRAM_WEBHOOK_PATH` | `/telegram/webhook` | Webhook route |
| `HOST_CLAUDE_CONFIG` | `/host-claude-config` | Mounted host `~/.claude` (for git, settings, skills) |

Access to `/mcp` is IP-restricted to `127.0.0.1`, `::1`, and Docker bridge CIDRs (`172.16.0.0/12`).

### How to Develop

The MCP server starts as part of `bun main.ts` (Docker). For isolated testing, the REST API endpoints in `mcp/dashboard-api.ts` can be exercised with `curl` or the dashboard UI. Adding a new tool: add schema + handler in `mcp/tools.ts`; mirror in `channel/tools.ts` if the tool must also be accessible from the host-side channel.

### Dependencies on Other Modules

- `sessions/manager.ts` — session CRUD
- `sessions/router.ts` — `routeMessage()`
- `memory/long-term.ts`, `memory/db.ts` — persistence
- `services/` — all service facades
- `utils/skill-handlers.ts`, `utils/skill-distiller.ts`, `utils/curator.ts`
- `bot/` — `bot` instance passed in for Telegram sends and webhook

---

## sessions

**Purpose.** Manages Claude Code session lifecycle — creation, state transitions, routing of Telegram messages to the correct session, and cascade deletion.

**Entry point.** `sessions/manager.ts` — `SessionManager` class, instantiated in `main.ts`.

### Key Files

| File | Responsibility |
|---|---|
| `sessions/manager.ts` | `SessionManager` — in-memory + DB session CRUD; `activeClients`, `liveTransports` maps |
| `sessions/state-machine.ts` | `transitionSession()`, `canTransition()`; `TRANSITIONS` map; broadcasts `session-state` SSE events |
| `sessions/router.ts` | `routeMessage(chatId, forumTopicId?)` → `RouteTarget` (standalone / cli / disconnected) |
| `sessions/delete.ts` | `deleteSessionCascade(sessionId)` — transactional cascade delete across all child tables |

### Public API / Exports

- `SessionManager` — `register()`, `registerRemote()`, `adoptOrRename()`, `disconnect()`, `switchSession()`, `getActiveSession()`, `markStale()`, `cleanup()`
- `routeMessage(chatId, forumTopicId?) → RouteTarget` — used by bot text/media handlers and enqueue helpers
- `transitionSession(id, from[], to)` — atomic state transition; returns `true` if row was updated
- `deleteSessionCascade(sessionId)` — full transactional delete

### Configuration

No dedicated env vars. Uses `DATABASE_URL` via the shared `sql` client.

### How to Develop

State machine logic is in `state-machine.ts`. Add new transitions by extending the `TRANSITIONS` map and validating the guard in `transitionSession()`. The routing logic (forum vs. DM) is entirely in `router.ts` and can be tested by querying the DB directly.

### Dependencies on Other Modules

- `memory/db.ts` — `sql` client
- `mcp/notification-broadcaster.ts` — SSE broadcast on state change
- `services/session-service.ts` — higher-level facade over `SessionManager` for dashboard API

---

## memory

**Purpose.** All PostgreSQL persistence: schema migrations, long-term memory with pgvector semantic search, short-term conversation context, session summarization, and project knowledge scanning.

**Entry point.** `memory/db.ts` — exports `sql` client and runs migrations on import; `migrate()` is called from `main.ts` at startup.

### Key Files

| File | Responsibility |
|---|---|
| `memory/db.ts` | SQL client (`postgres` tagged templates); migration framework; all 43 migrations |
| `memory/long-term.ts` | `remember()`, `recall()`, `rememberSmart()` (LLM dedup), `forget()`, `listMemories()` |
| `memory/short-term.ts` | `addMessage()`, `getContext()`, `getProjectHistory()`; in-memory LRU cache |
| `memory/summarizer.ts` | `trySummarize()`, `summarizeWork()`, `extractProjectKnowledge()`, `extractFactsFromTranscript()` |
| `memory/embeddings.ts` | Ollama embedding client — `embed()`, `embedBatch()`, `embedSafe()` |
| `memory/project-scanner.ts` | First-time project metadata scan → seed facts to long-term memory |

### Public API / Exports

- `sql` — tagged-template PostgreSQL client (re-exported to all modules)
- `migrate()` — runs pending migrations; called once at startup
- `remember(memory)`, `recall(query, options)`, `rememberSmart(memory)`, `forget(id)`, `listMemories(options)` — long-term memory CRUD
- `addMessage(msg)`, `getContext(sessionId, chatId)`, `getProjectHistory(projectPath, chatId, limit)` — short-term context
- `embed(text)`, `embedSafe(text)` — Ollama embedding helpers

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection |
| `OLLAMA_URL` | `http://localhost:11434` | Embedding backend |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model (768-dim) |
| `SUMMARIZE_MODEL` | `""` | Local Ollama model for summarization (falls back to Claude if empty) |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Claude model for summarization |
| `ANTHROPIC_API_KEY` | `""` | Used by smart reconciliation (`claude-haiku-4-5-20251001`) |
| `SHORT_TERM_WINDOW` | `20` | Messages kept in context window |
| `IDLE_TIMEOUT_MS` | `900000` | Idle summarization trigger (ms) |
| `MEMORY_SIMILARITY_THRESHOLD` | `0.35` | Cosine distance cutoff for smart dedup |
| `MEMORY_RECONCILE_TOP_K` | `5` | Candidates fetched for LLM decision |
| `MEMORY_TTL_*_DAYS` | varies | Per-type retention (fact=90, summary=60, decision=180, note=30, project_context=180) |

### How to Develop

Run migrations standalone: `bun memory/db.ts`. The migration array in `db.ts` is the single source of truth — append new migrations at the end with the next version number. Note the version gap (v22 → v39); do not fill it. For embedding changes, test with `embedSafe()` which degrades gracefully when Ollama is unavailable.

### Dependencies on Other Modules

None — `memory/` is the foundation layer. Other modules depend on it, not vice versa (except `memory/summarizer.ts` which calls `utils/aux-llm-client.ts`).

---

## services

**Purpose.** Thin domain-service facades over DB queries and core module logic. Consumed by bot command handlers and the MCP dashboard API to avoid direct DB coupling.

**Entry point.** `services/index.ts` — re-exports all service instances.

### Key Files

| File | Responsibility |
|---|---|
| `services/session-service.ts` | `SessionService` — flat session types for API responses; list, get, detail, rename, delete, switch |
| `services/forum-service.ts` | `ForumService` — Telegram forum topic CRUD; create, validate, sync, clean orphans |
| `services/memory-service.ts` | `MemoryService` — pass-through facade to `memory/long-term.ts` |
| `services/message-service.ts` | `MessageService` — short-term messages + queue insertion |
| `services/permission-service.ts` | `PermissionService` — permission lifecycle: pending→approved/rejected/expired |
| `services/project-service.ts` | `ProjectService` — project registry; start/stop via `admin_commands` table |
| `services/summarization-service.ts` | `SummarizationService` — idle timers, overflow check, force-summarize, onDisconnect |
| `services/provider-service.ts` | `ProviderService` — operator-registered Anthropic-compatible backends (GLM, Kimi, DeepSeek, OpenRouter, custom); CRUD over the `providers` table, per-project provider/model selection |
| `services/reviewer-service.ts` | `ReviewerService` — configured code-review providers (Codex, provider-model reviewers); CRUD, health checks, invoking a reviewer run |
| `services/ask-question.ts` | Backing service for Claude Code's `AskUserQuestion` hook — `question_requests` lifecycle: create, poll for an answer, expire, format for Telegram (polls and typed answers) |
| `services/review-artifacts.ts` | Persists and prunes code-review run output (`persistReviewRun`); the only place that writes review artifacts, so scheduled and manual runs both get pruning |

### Public API / Exports

Each service exposes a class instance. Key methods:

- `sessionService.list()`, `.get(id)`, `.getDetail(id)`, `.delete(id)`, `.switchChat(chatId, sessionId)`
- `forumService.setup(chatId)`, `.sync()`, `.cleanOrphans()`, `.createTopicForProject(project)`
- `memoryService.remember(m)`, `.recall(query, opts)`, `.forget(id)`, `.list(opts)`
- `messageService.queue(sessionId, chatId, content, attachments?)`, `.getContext(sessionId, chatId)`
- `permissionService.transition(id, next)`, `.expireStale(timeoutMs)`
- `projectService.list()`, `.create(name, path)`, `.start(id)`, `.stop(id)`, `.delete(id)`
- `summarizationService.touchIdleTimer()`, `.force()`, `.onDisconnect()`

### Configuration

Inherits `DATABASE_URL` from `memory/db.ts`. Forum service uses `TELEGRAM_BOT_TOKEN` for Telegram API calls.

### How to Develop

Each service is a class wrapping raw SQL queries or delegating to memory/session modules. Adding a new service: create `services/<name>-service.ts`, export an instance, re-export from `services/index.ts`.

### Dependencies on Other Modules

- `memory/db.ts` — SQL client
- `memory/long-term.ts`, `memory/short-term.ts`, `memory/summarizer.ts` — data layer
- `sessions/manager.ts` — session operations
- `sessions/delete.ts` — cascade delete

---

## adapters

**Purpose.** Adapter pattern registry for CLI runtime delivery. Abstracts how messages are sent to Claude Code sessions. Currently only the `claude` adapter is registered.

**Entry point.** `adapters/index.ts` — side-effect import registers all adapters at startup (`import "./adapters/index.ts"` in `main.ts`).

### Key Files

| File | Responsibility |
|---|---|
| `adapters/types.ts` | `CliAdapter`, `CliConfig`, `MessageMeta` interfaces; adapter `Map` registry; `getAdapter(type)` |
| `adapters/claude.ts` | `claudeAdapter` — `send()` inserts into `message_queue`; `isAlive()` always `true` |
| `adapters/index.ts` | Registers `claudeAdapter` into the registry |

### Public API / Exports

- `getAdapter(cliType: string) → CliAdapter` — throws if not registered
- `CliAdapter` interface: `send(sessionId, text, meta)`, `isAlive(config)`

### Configuration

No dedicated env vars. Relies on `DATABASE_URL` via `sql`.

### How to Develop

To add a new CLI runtime (e.g., Codex): implement `CliAdapter`, register it in `adapters/index.ts`, and set the `cli_type` column on the session row to the new type string.

### Dependencies on Other Modules

- `memory/db.ts` — `sql` for `message_queue` inserts

---

## orchestrator

**Purpose.** State Matrix validation gate for artifacts a session is about to hand back — replies and tool requests checked against a per-project rules file before they go out, with a bounded correct-and-retry loop when they fail.

**Entry point.** `orchestrator/gate.ts` — `validateReplyGate()`, called from the `reply` tool path before a message is delivered.

### Key Files

| File | Responsibility |
|---|---|
| `orchestrator/gate.ts` | `validateReplyGate()` — loads the project's State Matrix, validates the artifact, and returns `allow` / `config_error` / `blocked` (with a correction prompt) / `exhausted` |
| `orchestrator/matrix.ts` | `MatrixArtifact`, `StateMatrix` types; `loadStateMatrix()`, `validateMatrixArtifact()`, `buildCorrectionPrompt()` — the rules and the check itself |
| `orchestrator/store.ts` | Persistence for `orchestration_runs` / `matrix_violations`: `getOrCreateRun()`, `markRunStatus()`, `recordValidationFailure()`, `enqueueCorrection()` |

### Public API / Exports

- `validateReplyGate({ sql, sessionId, chatId, projectPath, text }) → ReplyGateResult` — the single entry point; `mode: "disabled"` when the project has no State Matrix configured.
- `loadStateMatrix(projectPath)`, `validateMatrixArtifact(matrix, artifact)` — usable independently for tool-request artifacts, not just replies.

### Configuration

No dedicated env vars. Behavior is entirely project-local, driven by whether a State Matrix config file is present for `projectPath`; absent means `mode: "disabled"` and every artifact passes.

### How to Develop

A run is scoped by `(session_id, chat_id, project_path, artifact_type)` and stays `validating` / `correcting` / `waiting_permission` until it resolves; `orchestration_runs` and `matrix_violations` are documented in [data-models.md](data-models.md#orchestration).

### Dependencies on Other Modules

- `memory/db.ts` — SQL client for `orchestration_runs` / `matrix_violations`
- Called from the `reply` tool dispatch path in `channel/tools.ts` / `mcp/tools.ts`

---

## utils

**Purpose.** Cross-cutting utility library: TTS synthesis, ASR transcription, aux LLM client, Skills Toolkit runtime (distiller, curator, approval, preprocessor, handlers), API/transcription stats, tmux/output monitoring, and shared helpers.

**Entry point.** No single entry point — individual files are imported by consumers.

### Key Files

| File | Responsibility |
|---|---|
| `utils/tts.ts` | Multi-provider TTS: kokoro-js, Piper, Yandex SpeechKit, Groq Orpheus, OpenAI; `synthesize()`, `shouldSendVoice()` |
| `utils/transcribe.ts` | Voice→text: Groq Whisper (primary) + local Whisper fallback; `transcribe()` |
| `utils/aux-llm-client.ts` | Multi-provider aux LLM (DeepSeek/Ollama/OpenRouter); `callAuxLlm()`; cost tracking |
| `utils/stats.ts` | `recordApiRequest()`, `recordTranscription()`, `appendLog()`, `getApiStats()` |
| `utils/curator.ts` | Skills lifecycle manager — weekly auto-pin/archive/consolidate; `runCurator()` |
| `utils/skill-distiller.ts` | Transcript → SKILL.md via aux LLM; `distillSkill()`; `approveSkill()`, `rejectSkill()` |
| `utils/skill-approval.ts` | Telegram approval messages for proposed skills and curator actions |
| `utils/skill-handlers.ts` | `handleSkillView()` — DB-first then filesystem lookup; inline shell expansion; disk materialization |
| `utils/skill-preprocessor.ts` | `` !`cmd` `` inline shell expansion with restricted env; `expandInlineShell()` |
| `utils/tools-reader.ts` | `readSkills()`, `readCommands()`, `readHooks()` from host Claude config dir |
| `utils/transcript-locate.ts` | Finds a session's own JSONL transcript by matching the `cwd` inside it; incremental offset tail |
| `utils/transcript-events.ts` | Transcript entry → status line (`thinking`, `text`, `tool_use`, `tool_result`), in the vocabulary `pane-parse.ts` already speaks |
| `utils/transcript-monitor.ts` | Preferred status monitor: polls the transcript, keeps a bounded line buffer; falls back to tmux when nothing resolves |
| `utils/tmux-monitor.ts` | Fallback: polls tmux pane output; parses tool calls/thinking/progress for status updates |
| `utils/output-monitor.ts` | Fallback: file-based alternative to tmux-monitor (uses `script` capture files) |
| `utils/stream-json-parser.ts` | Streaming JSONL parser for Claude Code stdout |
| `utils/claude-usage.ts` | Parses Claude Code `.jsonl` session files for per-model token stats |
| `utils/chunk.ts` | `chunkText()`, `chunkMarkdown()` — split text at Telegram's 4096-char limit; `chunkMarkdown` carries oversized code fences across chunks rather than dropping them |
| `utils/html.ts` | HTML-escaping helpers for Telegram HTML-mode messages |
| `utils/admin-format.ts` | Formats the numbers shown by `/status`/`/stats` and parses the arguments those commands accept |
| `utils/ask-question.ts` | Formats `AskUserQuestion` questions/answers for Telegram (polls and typed-answer prompts); paired with `services/ask-question.ts` |
| `utils/callback-route.ts` | Maps an inline-keyboard `callback_data` prefix to the handler it belongs to |
| `utils/cli-config.ts` | Normalizes `sessions.cli_config` read from the DB — tolerates legacy/broken JSONB shapes |
| `utils/cli-flags.ts` | Command-line flag parsing for the `helyx` CLI (`cli.ts`) |
| `utils/cyrillize.ts` | Transliterates Latin script into Cyrillic spelling so the Russian TTS voice pronounces it correctly |
| `utils/dashboard-readiness.ts` | `dashboardReadiness()`, `shouldOfferMiniApp()` — whether `ENABLE_DASHBOARD` and what was actually built (`WITH_DASHBOARD`) agree; drives the `/webapp` 503 and Mini App menu-button suppression |
| `utils/duration.ts` | Parses the CLI duration argument shared by several commands (`30m`, `2h`, `1d`) |
| `utils/error-stream.ts` | Classifies which of the bot's own error/log lines are worth forwarding to the operator |
| `utils/files.ts` | Downloads Telegram files; maps host↔container download paths (`toHostPath()`) |
| `utils/hold-counter.ts` | `HoldCounter` — reference-counted hold keyed by string, for signals two concurrent prompts can both be holding (e.g. the 💬 permission-waiting indicator) |
| `utils/hook-token.ts` | Shared secret (`X-Helyx-Hook-Token`) between Claude Code hooks on the host and the bot in its container |
| `utils/host-memory.ts` | Reads how much RAM the host can actually give a model; picks which local Ollama presets fit |
| `utils/llm-output.ts` | Cleans up raw model output — `stripReasoning()` strips `<think>`-style reasoning blocks |
| `utils/llm-stream.ts` | Shared streaming-response plumbing for `claude/client.ts`: SSE line reading, OpenAI/Ollama chunk parsing, retry/backoff, provider selection |
| `utils/media-attachment.ts` | Decides whether a photo travels to Claude inlined as base64 or as a path, by size (`IMAGE_INLINE_MAX_BYTES`) |
| `utils/memory-triage.ts` | Decides what is worth remembering and what is allowed to TTL-expire |
| `utils/now-render.ts` | Renders the `/now` "what is happening" card |
| `utils/pane-parse.ts` | Turns Claude Code's terminal output into a status block; vocabulary shared with `transcript-events.ts` |
| `utils/permission-prompt.ts` | Canonical shape of a Claude Code permission dialog, shared by `channel/permissions.ts` and `scripts/tmux-watchdog.ts` |
| `utils/reply-context.ts` | Captures/reads the Telegram message a native reply pointed to (`message_queue.reply_context`, migration v49) |
| `utils/reply-summary.ts` | Builds the spoken voice recap of a reply (`proseOf()`, `shouldSummarize()`) |
| `utils/request-guards.ts` | Checks between an untrusted HTTP request and the filesystem/shell/identity it is allowed to touch, e.g. `containsPath()` (boundary-correct path containment, not a prefix test) |
| `utils/requeue.ts` | Puts a Claude question back on the queue after a turn ended without an answer — the response guard's re-queue path |
| `utils/restart-lease.ts` | File-based one-restart-at-a-time lease for `bounce`/`host_restart`/`full_restart`/`/up` (`LEASE_EXPIRY_MS` = 15 min) |
| `utils/session-snapshot.ts` | Answers what a session is doing without asking it, from `pane_snapshot` and transcript state |
| `utils/skill-format.ts` | Shared SKILL.md file-format parsing/serialization |
| `utils/status-continuation.ts` | Decides whether a live status message should still represent the in-flight turn, or belongs to one already closed |
| `utils/status-format.ts` | What the live status message shows while Claude works (spinner, elapsed time, current tool) |
| `utils/status-render.ts` | Renders the status message body: the terminal-output section (expandable blockquote, `<pre>` pane) and the running-totals line |
| `utils/stop-hook.ts` | Registers/unregisters helyx's Stop hook in Claude Code's global settings |
| `utils/subagent-transcripts.ts` | Where a subagent writes its transcript, and what to call it |
| `utils/supervisor-callbacks.ts` | The `sup:` inline-button protocol used by supervisor Telegram alerts |
| `utils/supervisor-status.ts` | Decides what the supervisor's 5-minute status broadcast says |
| `utils/terminal.ts` | Reads raw terminal output — shared low-level capture helper under the tmux/output monitors |
| `utils/turn-summary.ts` | Composes and delivers "the turn is over": `deliverTurnSummary()`, `pg_notify('turn_closed_<session>', …)` |
| `utils/typing.ts` | Sends Telegram's "typing" chat action repeatedly (resent every 4s) until stopped |

### Public API / Exports

All exports are named exports from individual files. Major entry points:

- `synthesize(text)` → `{ buf, fmt } | null` — TTS
- `transcribe(audioBuffer, fileName, mimeType)` → `string | null` — ASR
- `callAuxLlm(systemPrompt, userPrompt, purpose)` → `AuxLlmResponse | AuxLlmError`
- `runCurator()` → `CuratorRun`
- `distillSkill(sessionId, chatId, transcript)` → proposed skill
- `handleSkillView(name, ctx)` → JSON string with skill content
- `expandInlineShell(body, cwd?)` → `ExpandResult`
- `recordApiRequest(stat)`, `recordTranscription(stat)`, `getApiStats()`

### Configuration

| Variable | Module | Purpose |
|---|---|---|
| `TTS_PROVIDER` | tts.ts | `auto`/`piper`/`yandex`/`kokoro`/`openai`/`groq`/`none` |
| `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | tts.ts | Yandex SpeechKit |
| `GROQ_API_KEY` | tts.ts, transcribe.ts | Groq TTS + Whisper ASR |
| `OPENAI_API_KEY` | tts.ts | OpenAI TTS |
| `WHISPER_URL` | transcribe.ts | Local Whisper endpoint |
| `HELYX_AUX_LLM_PROVIDER` | aux-llm-client.ts | `deepseek`/`ollama`/`openrouter` |
| `HELYX_AUX_LLM_MODEL` | aux-llm-client.ts | Override aux LLM model |
| `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` | aux-llm-client.ts | Provider credentials |
| `HELYX_CURATOR_ARCHIVE_DAYS` | curator.ts | Auto-archive threshold (default 90) |
| `HELYX_CURATOR_PIN_USE_COUNT` | curator.ts | Auto-pin threshold (default 10) |
| `HELYX_CURATOR_PAUSED` | curator.ts | Emergency pause flag |
| `HELYX_SHELL_TIMEOUT_MS` | skill-preprocessor.ts | Shell token timeout (default 5000ms) |
| `HELYX_SHELL_OUTPUT_CAP` | skill-preprocessor.ts | Shell output cap (default 4096 bytes) |
| `CLAUDE_SKILLS_DIR` | skill-handlers.ts | Skills directory override |
| `HOST_CLAUDE_CONFIG` | tools-reader.ts | Host `~/.claude` mount path |

### How to Develop

TTS changes: edit `utils/tts.ts` and restart the host `channel.ts` (not Docker). Kokoro ONNX model is lazy-loaded on first use. Aux LLM client changes only affect Docker-side (curator, distiller). Skills Toolkit: distiller and curator prompts are in `prompts/` — edit those for behavior tuning.

Unit tests: `bun test tests/unit/tts.test.ts`, `bun test tests/unit/skill-distiller.test.ts`, etc.

### Dependencies on Other Modules

- `memory/db.ts` — `sql` for stats, skill storage
- `channel/telegram.ts` — skill approval messages (host-side)
- `bot/` — skill approval messages (Docker-side, via Telegram bot)

---

## scripts

**Purpose.** Background daemons and operational shell scripts. Runs on the host machine (not in Docker). Handles: command-queue execution, tmux session supervision, session health watchdog, process-health heartbeats, DB backup, Claude Code auto-restart, and skill curation scheduling.

**Entry point.** `scripts/admin-daemon.ts` — launched by `helyx.service` (systemd) or `bun admin-daemon.ts`.

### Key Files

| File | Responsibility |
|---|---|
| `scripts/admin-daemon.ts` | Main host daemon: drains `admin_commands` table every 2s; starts supervisor + tmux-watchdog; runs curator cron; writes process-health heartbeats |
| `scripts/supervisor.ts` | `startSupervisor()` — 5 monitoring loops: session heartbeat, stuck queue, voice cleanup, status broadcast, idle auto-compact |
| `scripts/tmux-watchdog.ts` | `startTmuxWatchdog()` — polls tmux panes every 5s; detects dev-channel prompt, permission prompts, stalls, open editors, credential prompts, crashes |
| `scripts/run-cli.sh` | Auto-restart wrapper for Claude Code CLI; handles `.env` layering, tmux auto-confirm, log capture |
| `scripts/backup-db.sh` | Daily `pg_dump` + gzip + 7-day rotation; runs inside the postgres container |
| `scripts/save-session-facts.sh` | Claude Code Stop hook; POSTs transcript path to `/api/hooks/stop` |
| `scripts/helyx.service` | systemd service unit (`Type=forking`) for `admin-daemon.ts` |
| `scripts/init-ollama.sh` | Polls Ollama readiness; pulls embedding model if absent |

### Supported `admin_commands`

| Command | Payload | Action |
|---|---|---|
| `tmux_start` | — | `bun cli.ts up -s` |
| `tmux_stop` | — | Kill `bots` tmux session; mark sessions inactive |
| `proj_start` | `{ path }` | Open tmux window; run `run-cli.sh` |
| `proj_stop` | `{ name?, project_id? }` | Kill tmux windows; mark sessions inactive |
| `bounce` | — | Detached `bun cli.ts bounce` |
| `channel_kill` | — | `pkill bun …channel.ts` |
| `docker_restart` | `{ container }` | `docker restart <container>` |
| `restart_admin_daemon` | — | Spawn new daemon; `process.exit(0)` |
| `tmux_send_keys` | `{ project, action }` | Send Escape/interrupt/close_editor to tmux pane |

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL |
| `TELEGRAM_BOT_TOKEN` | required | Watchdog Telegram notifications |
| `SUPERVISOR_CHAT_ID` | — | Alert destination |
| `SUPERVISOR_TOPIC_ID` | `0` | Alert topic |
| `IDLE_COMPACT_MIN` | `60` | Minutes before idle auto-compact |
| `HELYX_CURATOR_CRON` | Sundays 03:00 UTC | Cron expression for curator runs |

### How to Develop

Start the daemon manually: `bun scripts/admin-daemon.ts`. To test supervisor loops in isolation, import `startSupervisor(sql, runShell)` directly. The watchdog can be tested by creating a tmux session named `bots` with a Claude Code pane. Shell scripts require `tmux` and `docker` to be in PATH.

The `cleanup/` sub-module runs as a separate concern:

- **Entry point:** `cleanup/runner.ts` — called hourly from `main.ts` or via `bun cleanup/runner.ts`
- **Jobs:** message-queue pruning, log rotation, archived message/permission cleanup, memory TTL, orphan session cascade delete, stale session archival
- **Configuration:** `ARCHIVE_TTL_DAYS`, `MEMORY_TTL_*_DAYS` in `config.ts`

### Dependencies on Other Modules

- `memory/db.ts` — SQL client
- `memory/summarizer.ts` — idle auto-compact, `extractFactsFromTranscript`
- `utils/curator.ts` — curator cron scheduling
- `sessions/manager.ts` — session state transitions and cleanup

---

## dashboard

**Purpose.** Browser-based admin control panel. Two independent Vite/React SPAs served as static assets by the MCP HTTP server. The main dashboard provides session monitoring, memory management, project configuration, permission approvals, and git browsing. The webapp is a Telegram Mini App for mobile access.

**Entry points.**
- Main dashboard: `dashboard/src/main.tsx` → served at `/`
- Webapp (Mini App): `dashboard/webapp/src/main.tsx` → served at `/webapp/`

### Key Files

| File | Responsibility |
|---|---|
| `dashboard/src/api/client.ts` | Base `fetch` wrapper with 401-redirect and cookie auth |
| `dashboard/src/pages/OverviewPage.tsx` | System status, active sessions, 24h token usage |
| `dashboard/src/pages/SessionsPage.tsx` | Sortable session table; rename/delete |
| `dashboard/src/pages/SessionDetailPage.tsx` | Messages, timeline, stats, git browser, GitHub PRs |
| `dashboard/src/pages/MemoriesPage.tsx` | Memory browser with type/tag/project filters |
| `dashboard/src/pages/ProjectsPage.tsx` | Project registry; create/start/stop/delete |
| `dashboard/src/pages/PermissionsPage.tsx` | Pending approvals (approve/deny/always-allow) |
| `dashboard/src/pages/MonitorPage.tsx` | Process health; daemon/Docker restart actions |
| `dashboard/src/pages/StatsPage.tsx` | API usage charts; Claude Code usage by project |
| `dashboard/src/pages/LogsPage.tsx` | Paginated request log with level/session/search filters |
| `dashboard/webapp/src/App.tsx` | Mini App: git / permissions / monitor / timeline / sessions / processes tabs |
| `mcp/dashboard-api.ts` | Backend: all REST route handlers that the SPA consumes |
| `dashboard/auth.ts` | JWT signing/verification; Telegram Login Widget verification; Mini App initData verification |

### Public API

The SPAs consume the REST API served by `mcp/dashboard-api.ts`. Key endpoint groups: `/api/auth/*`, `/api/sessions/*`, `/api/memories/*`, `/api/projects/*`, `/api/permissions/*`, `/api/stats/*`, `/api/logs`, `/api/git/:sessionId/*`, `/api/events` (SSE). Full list in the `mcp` module section.

### Authentication

- **Main dashboard:** Telegram Login Widget → JWT `HttpOnly` cookie (7-day); CSRF via `Origin` vs `Host` check.
- **Mini App:** Telegram `initData` HMAC-SHA256 → JWT Bearer token in response body (1-hour freshness window).

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | derived from `TELEGRAM_BOT_TOKEN` | JWT signing key |
| `TELEGRAM_BOT_TOKEN` | required | Login Widget verification |
| `PORT` | `3847` | Port the SPAs are served on |

### How to Develop

```bash
# Main dashboard dev server (Vite HMR)
cd dashboard && bun run dev

# Webapp dev server
cd dashboard/webapp && bun run dev
```

For production: `bun run build` in each SPA directory outputs to `dist/`; the Docker build copies these into the image. The backend API (`mcp/dashboard-api.ts`) runs inside Docker — proxy requests to `http://localhost:3847` from the Vite dev server.

Real-time updates use `EventSource` from `/api/events` (SSE); the `useEventStream` hook reconnects automatically on disconnect.

### Dependencies on Other Modules

All dashboard data comes from the REST API (`mcp/dashboard-api.ts`). The backend routes call:
- `services/session-service.ts`, `services/memory-service.ts`, `services/project-service.ts`, `services/permission-service.ts`
- `memory/db.ts` — direct SQL for stats/log queries
- `mcp/notification-broadcaster.ts` — SSE events
- `utils/claude-usage.ts` — Claude Code JSONL stats parsing

---

*Generated by autodoc-writer. Source artifacts: `jobs/autodoc-helyx/artifacts/`.*

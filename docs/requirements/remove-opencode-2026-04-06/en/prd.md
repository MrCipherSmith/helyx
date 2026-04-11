# PRD: Remove OpenCode Integration — Refocus on Claude Code

**Date:** 2026-04-06  
**Status:** Proposed  
**Author:** altsay  
**Scope:** Full OpenCode removal, Claude Code focus, preserve new UX/architecture wins

---

## 1. Overview

Remove all OpenCode integration from the bot and refocus entirely on Claude Code as the single CLI backend. Preserve and improve the architectural wins introduced during OpenCode development: adapter pattern, session CLI types, `/skills`, `/commands`, `/hooks`, `/add`, `/model` commands.

---

## 2. Why Remove OpenCode

The bot's core value is the **deep MCP integration with Claude Code**:
- Permission forwarding with inline buttons (Allow / Always / Deny)
- Real-time tmux progress monitoring
- Memory system with pgvector
- Two-way MCP tool calls from Claude

OpenCode integration delivers none of this:
- No permission forwarding
- No MCP tools — just HTTP POST + SSE text forwarding
- No memory integration
- Essentially equivalent to an SSH client with extra steps

**Net result:** OpenCode adds ~600 lines of code, increases maintenance surface, and confuses the product identity without adding real value over the Claude Code path.

---

## 3. Goals

- Remove all OpenCode-specific code paths, files, and CLI commands
- Keep the adapter pattern (`adapters/`) as extensible architecture
- Keep `/add`, `/model` commands — repurpose for Claude-specific configuration
- Keep `/skills`, `/commands`, `/hooks` — unrelated to OpenCode, high value
- Simplify CLI: remove provider choice prompts, always assume Claude
- Remove `/connections` command (OpenCode-only, no Claude equivalent)
- Keep `cli_config` DB column for Claude model config (`cli_config.model`)

---

## 4. Non-Goals

- Removing the adapter pattern — keep `adapters/` with `ClaudeAdapter`
- Removing `cli_config` / `cli_type` DB columns — keep for forward compat
- Rewriting or restructuring existing Claude session flow
- Touching memory, permissions, tmux monitoring, voice, or media handling

---

## 5. Files to Delete

| File | Lines | Reason |
|------|-------|--------|
| `adapters/opencode.ts` | 236 | OpencodeAdapter — HTTP REST client for opencode serve |
| `adapters/opencode-monitor.ts` | 240 | SSE monitor for opencode session responses |
| `scripts/run-opencode.sh` | 46 | OpenCode TUI auto-restart launcher |

**Total deletions: ~522 lines**

---

## 6. Files to Modify

### 6.1 `adapters/index.ts`
- Remove `import { opencodeAdapter }` and `registerAdapter(opencodeAdapter)`
- Export only `claudeAdapter`

### 6.2 `adapters/types.ts`
- `CliAdapter.type` union: `"claude" | "opencode"` → `"claude"`
- Keep `CliConfig` interface intact (`model`, `port`, `autostart`, `tmuxSession` — model used by `/model` command)

### 6.3 `sessions/manager.ts`
- Remove `cliType` parameter from `register()` (always insert `'claude'`)
- Keep `updateCliConfig()` — used for `/model` command
- Keep `cli_type` + `cli_config` columns in SQL — no migration needed

### 6.4 `sessions/router.ts`
- Remove `cliType` from `RouteTarget.cli` mode
- Router still resolves standalone / cli / disconnected — keep this structure

### 6.5 `bot/commands/add.ts`
- Remove inline keyboard with two buttons
- New flow: `/add` → asks for project path → registers immediately as Claude session
- Remove `handleAddProviderCallback` with opencode path
- Keep the pattern of switching to the newly registered session

### 6.6 `bot/commands/model.ts`
- Remove `if (cliType === "opencode")` branch that calls `opencodeAdapter.listModels()`
- Keep Claude model selection with static `CLAUDE_MODELS` list

### 6.7 `bot/commands/connections.ts`
- **Delete file** — no Claude-side equivalent for provider API key management

### 6.8 `bot/handlers.ts`
- Remove `/connections` registration: `b.command("connections", handleConnections)`
- Remove import of `handleConnections`

### 6.9 `bot/text-handler.ts`
- Remove opencode adapter branch in message send path
- Remove `opencodeMonitor.setPending()` / `clearPending()` calls
- Message routing: always use `ClaudeAdapter.send()` (message_queue INSERT)

### 6.10 `bot/callbacks.ts`
- Remove `configure_provider:` callback handler and import of `handleConfigureProviderCallback`

### 6.11 `main.ts`
- Remove `opencodeMonitor` initialization: `setBot()`, `startAll()`
- Remove opencode cleanup in hourly timer (`cli_type = 'opencode'` SELECT + `monitor.stop()`)

### 6.12 `cli.ts`
- Remove `ensureOpencodeServe()` function (~25 lines)
- Remove opencode provider branch in `start()` function (TUI launch path)
- Remove opencode provider branch in `tmuxStart()` (opencode-serve startup + session ID fetch)
- Remove opencode provider branch in `tmuxAttach()` (session ID fetch + tmux cmd selection)
- Remove `_get-opencode-session` and `_set-opencode-session` internal commands
- Remove `--provider opencode` from `add` and `run` command examples
- Simplify provider selection in `start()`, `tmuxAdd()`, `tmuxRun()`, `tmuxAttach()`:
  - Remove `askChoice("Provider:", [...])` prompt
  - Always use Claude path
  - Keep `--claude` flag for explicit invocation (harmless, already the default)

### 6.13 `bot/bot.ts`
- Remove `/connections` from `setMyCommands()` if it was registered there (currently not — it's not in the menu list, safe)

---

## 7. Database

**No migration required.** Keep both columns as-is:

| Column | Keep | Reason |
|--------|------|--------|
| `cli_type TEXT DEFAULT 'claude'` | Yes | Forward compat; existing rows unaffected |
| `cli_config JSONB DEFAULT '{}'` | Yes | Stores `{ "model": "..." }` for `/model` command |

**Pre-removal cleanup (optional, for production):**
```sql
-- Convert any orphaned opencode sessions to claude
UPDATE sessions SET cli_type = 'claude', cli_config = '{}'
WHERE cli_type = 'opencode';
```

---

## 8. Telegram Commands After Removal

| Command | Before | After |
|---------|--------|-------|
| `/add` | [Claude Code] [opencode] inline keyboard | Direct: ask path → register as Claude session |
| `/model` | Dynamic list (opencode) or static (claude) | Static Claude model list only |
| `/connections` | opencode provider status | **Removed** |
| `/skills` | Unchanged | Unchanged |
| `/commands` | Unchanged | Unchanged |
| `/hooks` | Unchanged | Unchanged |

---

## 9. CLI Commands After Removal

```
Tmux:
  helyx add [dir] [--name]     Register project (always Claude Code)
  helyx run [dir]              Launch project in terminal
  helyx attach [dir]           Add window to running tmux session (bots)
  helyx up [-a] [-s]           Start all projects in tmux

Connect:
  helyx start [dir]            Register + launch in current terminal
  helyx connect [dir] [-t]     Start single CLI session
```

Removed: `--provider opencode`, `--opencode` flag, `ensureOpencodeServe`

---

## 10. What We Keep From OpenCode Sprint

| Item | Keep | Value |
|------|------|-------|
| `adapters/` directory | Yes | Clean abstraction, extensible |
| `adapters/types.ts` — CliAdapter interface | Yes | Registry pattern for future |
| `adapters/claude.ts` — ClaudeAdapter | Yes | Current message delivery |
| `sessions/router.ts` — RouteTarget | Yes | Clean typed routing (standalone/cli/disconnected) |
| `/add` command | Yes (simplified) | Session registration from Telegram |
| `/model` command | Yes (Claude-only) | Model selection for Claude sessions |
| `/skills`, `/commands`, `/hooks` | Yes | High-value, unrelated to opencode |
| `cli_type`, `cli_config` columns | Yes | Model storage, forward compat |
| `tmux session name "bots"` | Yes | Better name than "claude" |
| `helyx run`, `attach` commands | Yes | Useful CLI additions |
| `helyx docker-start` separation | Yes | Cleaner command semantics |

---

## 11. Implementation Phases

### Phase 1: Delete OpenCode files (5 min)
- Delete `adapters/opencode.ts`
- Delete `adapters/opencode-monitor.ts`
- Delete `scripts/run-opencode.sh`

### Phase 2: Clean adapter layer (15 min)
- Update `adapters/index.ts`
- Update `adapters/types.ts`

### Phase 3: Session management (20 min)
- Update `sessions/manager.ts`
- Update `sessions/router.ts`

### Phase 4: Bot commands (30 min)
- Rewrite `bot/commands/add.ts`
- Update `bot/commands/model.ts`
- Delete `bot/commands/connections.ts`
- Update `bot/handlers.ts`
- Update `bot/text-handler.ts`
- Update `bot/callbacks.ts`

### Phase 5: Entry points (30 min)
- Update `main.ts`
- Update `cli.ts` (largest file, most changes)

### Phase 6: Documentation (20 min)
- Update `README.md` — remove OpenCode section, simplify `/add` docs
- Update CLI help text in `cli.ts`

**Total estimated effort: ~2 hours**

---

## 12. Acceptance Criteria

```gherkin
Feature: Bot works as Claude-only after OpenCode removal

  Scenario: Register project from Telegram
    Given bot is running
    When user sends /add
    Then bot asks for project path (no provider choice)
    And session is registered with cli_type = 'claude'

  Scenario: Start project via CLI
    Given project registered in tmux-projects.json
    When user runs helyx start ~/my-project
    Then Claude Code launches (no provider prompt)

  Scenario: Model selection
    Given user is in an active Claude session
    When user sends /model
    Then bot shows Claude model options as inline buttons
    And /connections is not available

  Scenario: Skills and commands work
    Given ~/.claude/skills/ and ~/.claude/commands/ exist
    When user sends /skills or /commands
    Then inline buttons appear with no change from before

  Scenario: No opencode references in bot output
    Given bot is running
    When user inspects all Telegram commands
    Then no command mentions opencode or requires opencode serve
```

---

## 13. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Existing opencode sessions in DB | Low | Low | SQL UPDATE before deploy |
| tmux-projects.json with opencode entries | Low | None | Treated as claude silently |
| cli_config with opencode fields | None | None | Ignored by code |
| Breaking session registration flow | Medium | High | Test /add and channel.ts before merge |

---

## 14. Related Documents

- `docs/requirements/opencode-integration-2026-04-06/` — Original opencode PRD (archived)
- `docs/requirements/provider-management-2026-04-06/` — Original provider management PRD (archived)
- `docs/requirements/readme-update-2026-04-06/` — README v1.8.0 update (partially invalidated)

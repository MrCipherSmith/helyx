# PRD: README Update — Skills, Providers & OpenCode

## 1. Overview

Update the project README to accurately reflect all features implemented in the `v1.8.0` sprint: interactive Telegram commands for skills/commands/hooks, LLM provider management, and OpenCode TUI integration.

---

## 2. Context

- **Product:** Claude Bot (Telegram → Claude Code bridge)
- **Module:** `README.md` (project root)
- **Trigger:** 14 feature commits landed without README documentation
- **Gap:** README was 620 lines; code implemented ~150 lines worth of undocumented features
- **Resolved by:** commit a3d66e7

---

## 3. Problem Statement

The README described the bot as of v1.6. Three major feature areas were shipped but undocumented:
1. `/skills`, `/commands`, `/hooks` Telegram commands for interactive tool invocation
2. `/add`, `/model`, `/connections` for LLM provider management
3. OpenCode TUI integration with SSE monitoring and session sharing

Users reading the README had no way to discover these features existed.

---

## 4. Goals

- Document all new Telegram commands in the command table
- Add dedicated sections for skills/commands/hooks, LLM providers, OpenCode
- Update CLI command reference with `--provider` flag
- Update environment variables table
- Keep roadmap accurate (checked/unchecked)

---

## 5. Non-Goals

- Rewriting existing sections (architecture, installation, quick start)
- Adding screenshots for new features
- i18n / translated README
- Auto-generating docs from code

---

## 6. Functional Requirements

**FR-1: Telegram Commands Table**
- Table `## Telegram Commands` must list all bot commands grouped by category
- Every bot command registered in grammY bot must appear in this table
- Descriptions must match the actual command handler behavior

**FR-2: Skills, Commands & Hooks Section**
- Explain `/skills` reads from `~/.claude/skills/` (not knowledge base file)
- Explain `/commands` reads from `~/.claude/commands/*.md` with YAML frontmatter
- Explain `/hooks` reads from `settings.json` hooks array
- Show YAML frontmatter example for custom commands
- List hook event types: PreToolUse, PostToolUse, Stop, Notification
- Explain deferred input flow (args-required prompt + 5-min TTL)

**FR-3: LLM Providers Section**
- Document all four provider types: Google AI, Anthropic, OpenRouter, Ollama
- Explain `/add`, `/model`, `/connections` commands
- Document `--provider` CLI flag with examples for each type
- Note that provider config is stored in `cli_config` DB table

**FR-4: OpenCode Integration Section**
- Explain the full connection flow (add → serve → TUI → SSE → Telegram)
- Document that `opencode serve --hostname 0.0.0.0` is required
- Mention shared session ID between TUI and Telegram
- List status update types forwarded to Telegram

**FR-5: Environment Variables Table**
- `HOST_CLAUDE_CONFIG` — docker mount path for ~/.claude (default: `/host-claude-config`)
- `OPENCODE_PORT` — OpenCode serve port (default: `8000`)

**FR-6: CLI Commands Reference**
- `claude-bot add [dir] [--name] [--provider]` — with provider types
- `claude-bot attach <url>` — connect to running OpenCode
- Providers subsection showing example for each type

**FR-7: Roadmap**
- Check off `[x]` for: skills/commands, provider management, OpenCode integration
- Keep unchecked: multi-user, inline mode

**FR-8: Recent Changes Section**
- Add `## Recent Changes (v1.8.0)` near top of roadmap/guides section
- 4 bullet groups: Skills & Commands, LLM Providers, OpenCode, Database

---

## 7. Non-Functional Requirements

**NFR-1:** README must render correctly on GitHub (no broken Markdown)  
**NFR-2:** Section order must be logical: Quick Start → Features → CLI → Telegram → Skills → Providers → MCP → OpenCode → Setup → Production  
**NFR-3:** Every code example must be fenced with the appropriate language tag  
**NFR-4:** Table columns must be aligned (GitHub auto-aligns but source must be valid MD table syntax)  
**NFR-5:** Total README length target: 700–800 lines (not so long it becomes unusable)

---

## 8. Constraints

- Single-file README (no splitting into separate docs yet)
- Architecture diagram remains ASCII art (no Mermaid/images)
- All examples must use actual default values from `.env.example`
- Feature descriptions must match actual implementation (no aspirational language)

---

## 9. Edge Cases

- `/skills` section must clarify it reads from `~/.claude/skills/`, NOT from `KNOWLEDGE_BASE` — these are different systems
- `--provider` flag docs must note that default behavior (no flag) remains unchanged
- OpenCode section must clarify the bot runs in Docker but OpenCode runs on host

---

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: README accurately documents all v1.8.0 features

  Scenario: New user discovers /commands
    Given a user reads the README
    When they look at the Telegram Commands table
    Then they see /commands listed with description "Custom commands — inline buttons, click to execute"

  Scenario: New user learns about provider management
    Given a user reads the README
    When they look for LLM provider information
    Then they find a "LLM Providers" section explaining /add, /model, /connections
    And they find a CLI example: claude-bot add ~/project --provider opencode

  Scenario: Contributor checks environment variables
    Given a developer sets up the bot
    When they consult the Environment Variables table
    Then they find HOST_CLAUDE_CONFIG with its default value /host-claude-config
    And they find OPENCODE_PORT with default value 8000

  Scenario: User looks up OpenCode integration
    Given user wants to connect OpenCode TUI
    When they search README for OpenCode
    Then they find an "OpenCode Integration" section
    And it explains the full flow: add → serve → session share → SSE → Telegram

  Scenario: Roadmap reflects actual state
    Given a user reads the Roadmap section
    Then skills/commands, provider management, OpenCode items are checked [x]
    And multi-user and inline mode items are unchecked [ ]
```

---

## 11. Verification

- README renders without errors on GitHub
- All Telegram commands in grammY registration appear in the table: `grep "command(" bot/commands/*.ts | cut -d'"' -f2` matches table rows
- New ENV vars listed in both `.env.example` and README table
- Line count: 700–800

---

## 12. Related Documents

- `docs/requirements/telegram-tool-commands-2026-04-06/` — PRD for /skills /commands /hooks implementation
- `docs/requirements/telegram-webapp-2026-04-06/` — PRD for web dashboard
- `docs/requirements/readme-update-2026-04-06/en/report.md` — Analysis report of gap between code and docs

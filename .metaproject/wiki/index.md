# Project Wiki

Version: 1.0.0

## Purpose

This is the local project knowledge base. It stores knowledge that should
outlive a single task: architecture, domain models, business rules, user
scenarios, components, services, integrations, and known decisions.

Read this index first. Do not read every page unless necessary.

## Page Types

- `architecture` - system or module architecture
- `domain-model` - entities, invariants, relationships
- `business-rule` - business constraints and decisions
- `user-scenario` - user workflows and expected outcomes
- `component` - UI/component behavior and ownership
- `service` - backend/service responsibility and APIs
- `integration` - external systems and contracts
- `decision` - known decisions and ADR-like records

## Create A Page

```bash
keryx wiki new <type> <slug> --title "<title>"
keryx wiki collect
keryx wiki index
```

## Pages

<!-- keryx:wiki-index:begin -->
<!-- generated: 2026-07-23T12:00:00.000Z | pages: 20 -->

### Architecture

- [Project Map](architecture/project-map.md) (enriched) - System architecture overview: layered architecture with Telegram bot frontend, service layer, memory system, MCP server, and web dashboard.
- [Testing Map](architecture/testing-map.md) (enriched) - Test infrastructure: 17 unit tests (bun), 4 Playwright E2E specs across 3 projects.

### Domain Model

_No pages yet._

### Business Rule

_No pages yet._

### User Scenario

_No pages yet._

### Component

- [Module adapters](components/adapters.md) (enriched) - Adapter abstraction layer for LLM provider registration and resolution. 3 files, depends on `memory`.
- [Module bot](components/bot.md) (enriched) - Telegram frontend. 35 files, 23+ commands, dual-mode routing (CLI/standalone), streaming responses, voice pipeline, permission management.
- [Module channel](components/channel.md) (enriched) - Communication channel subsystem bridging Telegram webhook updates into internal processing. 9 files.
- [Module claude](components/claude.md) (enriched) - LLM interaction layer: multi-provider API client (Anthropic/Google/OpenRouter/Ollama) + prompt composer with memory fusion. 2 files.
- [Module cleanup](components/cleanup.md) (enriched) - Housekeeping jobs: message queue, log rotation, stale session archival, orphan CLI cleanup. 2 files.
- [Module dashboard](components/dashboard.md) (enriched) - Mobile-first Telegram Mini App (React + Vite) for monitoring sessions, stats, logs, memories, permissions. 35 files.
- [Module mcp](components/mcp.md) (enriched) - MCP server exposing bot services as tools for Claude Code. 6 files, 33 cross-module imports.
- [Module memory](components/memory.md) (enriched) - Persistence backbone: PostgreSQL, vector embeddings, short-term + long-term memory, conversation summarization. 6 files.
- [Module orchestrator](components/orchestrator.md) (enriched) - Reply gate validation and session state matrix. 3 files.
- [Module scripts](components/scripts.md) (enriched) - Background daemons: admin-daemon, supervisor, tmux watchdog and logger. 4 files.
- [Module services](components/services.md) (enriched) - Service layer facades: Session, Project, Permission, Forum, Message, Memory, Summarization services. 8 files.
- [Module sessions](components/sessions.md) (enriched) - Session lifecycle management: creation, routing, state machine, cleanup. 4 files.
- [Module tests](components/tests.md) (enriched) - Test suite: 17 unit tests, 4 Playwright E2E specs. 22 files.
- [Module utils](components/utils.md) (enriched) - Shared utilities: skills subsystem, curator, stats, TTS, transcription, tmux monitoring. 19 files.

### Service

_No pages yet._

### Integration

_No pages yet._

### Decision

_No pages yet._

<!-- keryx:wiki-index:begin -->
<!-- generated: 2026-08-01T20:35:50.808Z | pages: 16 -->

### Architecture

- [Project Map](architecture/project-map.md) (enriched) - Deterministic map of 163 code files, 2 assets, and 435 import edges across 26 top-level modules. The system is a Telegram bot that routes messages to Claude Code CLI sessions or standalone Claude API, with a web dashboard, MCP server, memory system, and supporting infrastructure.
- [Testing Map](architecture/testing-map.md) (draft) - Test infrastructure overview: 17 unit tests (bun test) and 4 Playwright E2E specs across 3 projects (api, dashboard). Unit tests cover core business logic; E2E tests validate dashboard rendering and API endpoints.

### Domain Model

_No pages yet._

### Business Rule

_No pages yet._

### User Scenario

_No pages yet._

### Component

- [adapters](components/adapters.md) (enriched)
- [bot](components/bot.md) (enriched)
- [channel](components/channel.md) (enriched)
- [claude](components/claude.md) (enriched)
- [cleanup](components/cleanup.md) (enriched)
- [dashboard](components/dashboard.md) (enriched)
- [mcp](components/mcp.md) (enriched)
- [memory](components/memory.md) (enriched)
- [orchestrator](components/orchestrator.md) (enriched)
- [scripts](components/scripts.md) (enriched)
- [services](components/services.md) (enriched)
- [sessions](components/sessions.md) (enriched)
- [tests](components/tests.md) (enriched)
- [utils](components/utils.md) (enriched)

### Service

_No pages yet._

### Integration

_No pages yet._

### Decision

_No pages yet._
<!-- keryx:wiki-index:end -->

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
<!-- generated: 2026-09-21T06:26:30.042Z | pages: 32 -->

### Architecture

- [Project Map](architecture/project-map.md) (enriched) - Deterministic map of 163 code files, 2 assets, and 435 import edges across 26 top-level modules. The system is a Telegram bot that routes messages to Claude Code CLI sessions or standalone Claude API, with a web dashboard, MCP server, memory system, and supporting infrastructure.
- [Quality Map](architecture/quality-map.md) (draft) - Generated from Code Health: gate warn, score 73, 278 findings.
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
- [bot/commands](components/bot-commands.md) (draft)
- [channel](components/channel.md) (enriched)
- [claude](components/claude.md) (enriched)
- [cleanup](components/cleanup.md) (enriched)
- [dashboard](components/dashboard.md) (enriched)
- [dashboard/src](components/dashboard-src.md) (draft)
    - [dashboard/src/components/ui](components/dashboard-src-components-ui.md) (draft)
  - [dashboard/src/hooks](components/dashboard-src-hooks.md) (draft)
  - [dashboard/src/lib](components/dashboard-src-lib.md) (draft)
  - [dashboard/src/pages](components/dashboard-src-pages.md) (draft)
  - [dashboard/webapp/src](components/dashboard-webapp-src.md) (draft)
    - [dashboard/webapp/src/components](components/dashboard-webapp-src-components.md) (draft)
    - [dashboard/webapp/src/utils](components/dashboard-webapp-src-utils.md) (draft)
- [mcp](components/mcp.md) (enriched)
- [memory](components/memory.md) (enriched)
- [orchestrator](components/orchestrator.md) (enriched)
- [root](components/root.md) (draft)
- [scratch-rlm-prototype](components/scratch-rlm-prototype.md) (draft)
- [scripts](components/scripts.md) (enriched)
- [services](components/services.md) (enriched)
- [sessions](components/sessions.md) (enriched)
- [tests](components/tests.md) (enriched)
- [tests/e2e](components/tests-e2e.md) (draft)
  - [tests/e2e/api](components/tests-e2e-api.md) (draft)
- [tests/fixtures](components/tests-fixtures.md) (draft)
- [tests/unit](components/tests-unit.md) (draft)
- [utils](components/utils.md) (enriched)

### Service

_No pages yet._

### Integration

_No pages yet._

### Decision

_No pages yet._
<!-- keryx:wiki-index:end -->

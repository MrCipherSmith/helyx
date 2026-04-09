# PRD: Structured Logging with pino

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** Medium  
**Effort:** M  

---

## Overview

Replace scattered `console.log` / `console.error` / `process.stderr.write` calls with a structured logger (pino), adding log levels, correlation IDs, and consistent output format.

---

## Problem

- **259 `console.*` call sites** across 20+ files — unstructured, no log level filtering
- **`channel.ts` uses `process.stderr.write`** (46 call sites) because stdout is reserved for MCP stdio transport — this is correct but inconsistent with the rest of the codebase
- Logs interleave across sessions with no way to correlate events from a single session, request, or tool call
- No log level control — debug noise mixes with errors in production
- No way to ship logs to external systems (Loki, Datadog, etc.) without reformatting

---

## Solution

Install `pino` (fast, low-overhead, JSON-native). Create a shared `logger.ts` module. Replace all `console.*` and `process.stderr.write` calls progressively.

---

## User Stories

1. **As a developer**, I want to filter logs by level (`DEBUG`, `INFO`, `WARN`, `ERROR`) so I see only what's relevant.
2. **As a developer**, I want each log line to include `sessionId` / `chatId` automatically so I can trace a full session flow without grepping multiple files.
3. **As an operator**, I want structured JSON logs so I can ship them to a log aggregator without custom parsers.

---

## Acceptance Criteria

- [ ] `pino` installed as runtime dependency
- [ ] `logger.ts` exported as singleton with configurable level via `LOG_LEVEL` env var
- [ ] Child loggers support: `logger.child({ sessionId })` propagates context to all log lines
- [ ] `channel.ts` uses `logger.child({ sessionId })` — stderr fallback preserved for MCP stdio mode
- [ ] `memory/summarizer.ts` uses structured fields (`{ sessionId, trigger, factsCount }`) not string interpolation
- [ ] `sessions/manager.ts` uses logger with `{ sessionId, clientId, status }` context
- [ ] `LOG_LEVEL=debug` enables verbose output; default is `info`
- [ ] No `console.log` calls remain in core runtime files (`channel.ts`, `mcp/`, `memory/`, `sessions/`, `bot/`)

---

## Technical Approach

### 1. Install pino

```bash
bun add pino
bun add -d @types/pino
```

### 2. Create `logger.ts`

```typescript
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // In MCP stdio mode, write to stderr to avoid polluting stdout
  transport: process.env.LOG_PRETTY === "true"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

export type Logger = pino.Logger;
```

### 3. channel.ts

Replace all `process.stderr.write(\`...\n\`)` with `log.info(...)` where `log = logger.child({ sessionId, source: "channel" })`.

Keep stderr output since stdout is MCP transport — pino can be configured to write to stderr:
```typescript
const logger = pino({ level: ... }, pino.destination(2)); // fd 2 = stderr
```

### 4. Progressive migration

Phase 1 (this PRD): `channel.ts`, `mcp/dashboard-api.ts`, `memory/summarizer.ts`, `memory/long-term.ts`, `sessions/manager.ts`  
Phase 2 (follow-up): remaining files in `bot/`, `cli.ts`

### 5. Correlation IDs

For HTTP requests in `dashboard-api.ts`:
```typescript
const reqId = crypto.randomUUID().slice(0, 8);
const reqLog = logger.child({ reqId, method, path });
```

---

## Files

- `package.json` — add `pino`
- `logger.ts` (new) — singleton logger
- `channel.ts` — replace `process.stderr.write` (~46 sites)
- `mcp/dashboard-api.ts` — replace `console.*` calls
- `memory/summarizer.ts` — structured fields
- `memory/long-term.ts` — structured fields, debug level for reconcile:noop
- `sessions/manager.ts` — child logger with sessionId context

---

## Out of Scope

- `cli.ts` — CLI output is intentionally human-readable, not JSON
- Shipping logs to external systems (Loki, Datadog) — follow-up PRD
- `pino-pretty` in production — dev-only

---

## Dependencies

- New package: `pino`
- Optional dev: `pino-pretty` for local development

---

## Risks

- `channel.ts` stdout must remain clean for MCP stdio — verify pino destination is stderr (fd 2), not stdout
- High call-site count (259) — migrate incrementally to avoid regressions

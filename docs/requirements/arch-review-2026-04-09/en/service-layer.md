# PRD: Application Service Layer

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** High  
**Effort:** XL  

---

## Overview

The project currently has no application service layer. Business logic for sessions, permissions, memory, and projects is spread across bot command handlers (`bot/commands/`), the HTTP API (`mcp/dashboard-api.ts`), and `channel.ts`. The same SQL queries and business rules appear in 3–4 different files. Introducing `SessionService`, `PermissionService`, `MemoryService`, and `ProjectService` creates a single authoritative implementation of each domain's operations.

---

## Problem

### Session logic is in four places

1. `channel.ts:83–178` — `resolveSession()`: raw SQL for session upsert, advisory locks, project lookup, routing transfer
2. `sessions/manager.ts:54–198` — `SessionManager.register()`, `registerRemote()`, `adoptOrRename()`, `disconnect()`: raw SQL
3. `mcp/dashboard-api.ts:165–228` — `handleSessions`, `handleSessionDetail`, `handleRenameSession`, `handleDeleteSession`: raw SQL
4. `bot/commands/session.ts:51–80+` — `handleSessions`, `handleSessionInfo`: reads via `sessionManager`

The `chat_sessions` routing table is queried from `mcp/dashboard-api.ts`, `channel.ts:334–338,660–664`, and `sessions/router.ts` — no single owner.

### Permission logic is in three places

1. `channel.ts:282–519` — full permission request lifecycle (send Telegram message, poll DB, resolve)
2. `mcp/dashboard-api.ts` — permission stats reads `permission_requests` directly
3. `bot/commands/admin.ts` — `handlePermissionStats` queries `permission_requests` via raw SQL

The "always allow" persistence path (writing to `settings.local.json`) is only implemented in `channel.ts:482`. No other part of the system can check or modify auto-approve rules.

### Memory logic split between channel.ts and memory/long-term.ts

- `channel.ts:785–904` — `embed()` called directly, raw SQL for `INSERT INTO memories`, raw SQL for vector search
- `memory/long-term.ts` — `remember()`, `recall()`, `searchProjectContext()`: the canonical implementations
- `channel.ts` re-implements the same vector search in `search_project_context` with slightly different field selection

### No project service

- `mcp/dashboard-api.ts:329–406` — all project CRUD: raw SQL
- `bot/commands/projects.ts`, `bot/commands/project-add.ts` — raw SQL or calls to `sessionManager`
- `sessions/manager.ts` `registerRemote()` — duplicates project-to-session link logic

---

## Solution

Introduce a `services/` layer with four service classes. All SQL for a domain lives in exactly one service. Route handlers and bot command handlers become thin wrappers that call the service.

```
services/
  session-service.ts     — all session + chat routing operations
  permission-service.ts  — permission requests, auto-approve rules, stats
  memory-service.ts      — remember, recall, forget, search, summarize triggers
  project-service.ts     — project CRUD, tmux integration, project-session links
  index.ts               — re-exports all four services as singletons
```

---

## User Stories

1. **As a developer adding a new bot command that lists sessions**, I call `sessionService.list()` and format the result — no SQL, no imports from `sessions/manager.ts`.
2. **As a developer adding a new dashboard API endpoint**, I call `sessionService.getDetail()` — no need to understand the JOIN or token stats query.
3. **As a developer debugging why auto-approve rules are not persisting**, I look at `PermissionService.addRule()` — one place, one implementation.
4. **As a developer writing an integration test**, I construct `SessionService` with a test DB and call `resolveRemote()` directly — no HTTP server needed.

---

## Acceptance Criteria

- [ ] `services/session-service.ts`, `services/permission-service.ts`, `services/memory-service.ts`, `services/project-service.ts` exist and export typed service classes
- [ ] `services/index.ts` exports singletons `sessionService`, `permissionService`, `memoryService`, `projectService`
- [ ] `mcp/dashboard-api.ts` route handlers contain no raw SQL — all DB access goes through service methods
- [ ] `bot/commands/session.ts`, `bot/commands/memory.ts`, `bot/commands/admin.ts`, `bot/commands/projects.ts`, `bot/commands/project-add.ts` use service singletons
- [ ] `channel/session.ts` (after channel-refactor) calls `sessionService.resolveRemote()` / `resolveLocal()` instead of raw SQL
- [ ] `channel/tools.ts` (after channel-refactor) calls `memoryService.remember()` / `recall()` / `searchProjectContext()`
- [ ] `sessions/manager.ts` is NOT deleted — `SessionManager` remains for transport-layer lifecycle methods (`trackTransport`, `linkClientToSession`, etc.)
- [ ] No circular dependency: services depend only on `memory/db.ts`, `memory/long-term.ts`, `sessions/delete.ts`
- [ ] All existing bot commands and API endpoints return the same data shapes as before

---

## Technical Approach

### SessionService

```ts
class SessionService {
  list(includeUnnamed?: boolean): Promise<Session[]>
  get(sessionId: number): Promise<Session | null>
  getActiveForChat(chatId: string): Promise<number>
  getDetail(sessionId: number): Promise<SessionDetail>
  switchChat(chatId: string, sessionId: number): Promise<void>
  rename(sessionId: number, name: string): Promise<Session>
  delete(sessionId: number): Promise<void>
  touchActivity(sessionId: number): Promise<void>

  // Channel-process operations
  resolveRemote(projectName: string, projectPath: string): Promise<{ id: number; existed: boolean }>
  resolveLocal(projectName: string, projectPath: string): Promise<number>
  markDisconnected(sessionId: number, source: "remote" | "local"): Promise<void>
  transferChatRouting(fromSessionIds: number[], toSessionId: number): Promise<void>
}
```

### PermissionService

```ts
class PermissionService {
  create(req: CreatePermissionRequest): Promise<PermissionRequest>
  getResponse(requestId: string): Promise<string | null>
  setResponse(requestId: string, behavior: string): Promise<void>
  delete(requestId: string): Promise<void>
  exists(requestId: string): Promise<boolean>

  // Auto-approve
  loadRules(projectPath: string): Promise<Set<string>>
  isAutoApproved(rules: Set<string>, toolName: string): boolean
  addRule(projectPath: string, toolName: string): Promise<void>  // writes settings.local.json

  // Stats
  getStats(sessionId?: number): Promise<PermissionStats>
  listPending(sessionId: number): Promise<PermissionRequest[]>
}
```

### MemoryService

```ts
class MemoryService {
  // Delegates to memory/long-term.ts
  remember(memory: Omit<Memory, "id" | "createdAt">): Promise<Memory>
  recall(query: string, options: RecallOptions): Promise<Memory[]>
  forget(id: number): Promise<boolean>
  list(options: ListOptions): Promise<{ memories: Memory[]; total: number }>
  listTags(): Promise<{ tag: string; count: number }[]>
  deleteByTag(tag: string): Promise<number>
  searchProjectContext(query: string, projectPath: string, limit?: number): Promise<Memory[]>
  triggerSummarize(sessionId: number, projectPath: string): Promise<void>
  triggerWorkSummary(sessionId: number): Promise<void>
}
```

### ProjectService

```ts
class ProjectService {
  list(): Promise<ProjectWithSession[]>
  get(id: number): Promise<Project | null>
  create(name: string, path: string): Promise<Project>
  delete(id: number): Promise<void>
  start(id: number): Promise<void>   // inserts admin_commands row
  stop(id: number): Promise<void>    // inserts admin_commands row
  getByPath(path: string): Promise<Project | null>
}
```

### Implementation steps

1. Create `services/session-service.ts` — extract SQL from `sessions/manager.ts` domain methods + `dashboard-api.ts` session handlers + `channel.ts` `resolveSession()`
2. Create `services/permission-service.ts` — extract poll loop SQL from `channel.ts:469–517`, insert SQL from `channel.ts:455–459`, `loadAutoApproveRules` from `channel.ts:242–260`
3. Create `services/memory-service.ts` — thin wrapper around `memory/long-term.ts`; move `triggerSummarize` fetch calls from `channel.ts:192–215`
4. Create `services/project-service.ts` — move `handleListProjects`, `handleCreateProject`, `handleDeleteProject` SQL from `dashboard-api.ts`
5. Update `mcp/dashboard-api.ts` — each `handle*` becomes 1–3 line service call + `sendJson`
6. Update bot command handlers — use service singletons
7. Update `channel/` modules — call service methods (after channel-refactor merged)

---

## Files

**Created:**
- `services/session-service.ts`
- `services/permission-service.ts`
- `services/memory-service.ts`
- `services/project-service.ts`
- `services/index.ts`

**Modified:**
- `mcp/dashboard-api.ts` — route handlers → service calls
- `bot/commands/session.ts`, `memory.ts`, `admin.ts`, `projects.ts`, `project-add.ts` — use singletons
- `channel/session.ts` (after channel-refactor) — uses `sessionService`
- `channel/tools.ts` (after channel-refactor) — uses `memoryService`
- `channel/permissions.ts` (after channel-refactor) — uses `permissionService`
- `sessions/manager.ts` — domain query methods deprecated (transport lifecycle stays)

**Unchanged:**
- `memory/long-term.ts`, `memory/embeddings.ts`, `memory/db.ts`
- `sessions/delete.ts`
- `sessions/router.ts`

---

## Out of Scope

- Changing Telegram message format of any existing command
- Pagination changes to existing list endpoints
- Introducing a repository pattern or query builder
- Caching layer or OpenAPI spec generation

---

## Dependencies

- `channel-refactor` PRD — not a hard prerequisite. Steps 1–4 (create services) can be done before channel-refactor. Steps 5–7 (update channel modules) require channel-refactor to be merged first.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `SessionService.resolveRemote()` and `SessionManager.registerRemote()` overlap — confusion about which to call | High | Document clear ownership: `SessionService` = application layer; `SessionManager` = transport layer. Add comments to both. |
| `/api/sessions/expect` endpoint uses `sessionManager.linkClientToSession()` — transport-layer, must NOT move to `SessionService` | Medium | Document `expect` endpoint explicitly as transport-layer |
| Channel process cannot import `services/index.ts` singletons (different `sql` connection) | High | `channel/` modules must instantiate service classes with their own `sql` connection, NOT use the main-process singletons |
| Bot command handlers use `sql` directly for edge cases not yet in services | Medium | Audit all `sql` imports in `bot/commands/` before marking done |

# PRD: channel.ts Modular Refactor

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** High  
**Effort:** L  

---

## Overview

`channel.ts` is a 1320-line monolithic stdio process combining session lifecycle, auto-approval rules, permission request handling, MCP tool dispatch, Telegram status management, and the message queue poller. This PRD describes splitting it into six focused modules without changing any observable runtime behaviour.

---

## Problem

Six unrelated concerns in one file:

| Lines | Concern |
|-------|---------|
| 1–73 | Env config, DB connection, `embed()` helper |
| 76–178 | `resolveSession()` — 3 modes, advisory locks |
| 180–260 | Idle timer, `triggerSummarize`, `markDisconnected` |
| 238–266 | Auto-approve rules |
| 268–519 | MCP server init + permission handler (250 lines) |
| 521–912 | MCP tool dispatch (`reply`, `react`, `edit_message`, `remember`, etc.) |
| 914–937 | Low-level Telegram helpers |
| 939–1091 | Status message state machine |
| 1093–1155 | Typing indicators and progress monitor |
| 1157–1252 | Message queue poller with LISTEN/NOTIFY |
| 1254–1319 | `main()` bootstrap and shutdown |

**Specific pain points:**

1. **Permission handler is 250 lines of inline logic** (lines 282–519): JSON parsing with regex fallback, detail string construction, preview assembly, Telegram sends, DB insert, 120-second polling loop — all in one closure, untestable.
2. **Status state machine is scattered** — `StatusState`, `activeStatus`, `sendStatusMessage`, `updateStatus`, `editStatusMessage`, `deleteStatusMessage` live at lines 939–1091 but are called from lines 402, 480, 494, 650, and 855.
3. **Bidirectional coupling** — `deleteStatusMessage` calls `stopTypingForChat` (line 1079); typing functions call `updateStatus`. Neither can be moved alone.
4. **MCP tool handlers contain raw SQL and `embed()` calls** (lines 785–812, 870–904) duplicating `memory/long-term.ts`.
5. **No unit testability** — all logic operates over module-level mutable globals (`sessionId`, `activeStatus`, `activeTyping`, `autoApprovePatterns`).

---

## Solution

Split into seven modules sharing a `ChannelContext` interface:

```
channel/
  index.ts          — entry point ~80 lines
  session.ts        — resolveSession(), markDisconnected(), triggerSummarize()
  permissions.ts    — PermissionHandler class
  tools.ts          — MCP tool registry and dispatch
  status.ts         — StatusManager class (status messages + typing + progress)
  poller.ts         — MessageQueuePoller + idle timer
  telegram.ts       — pure Telegram HTTP helpers (leaf module, no deps)
```

`channel.ts` becomes a 3-line shim: `import "./channel/index.ts"`.

**ChannelContext interface:**
```ts
interface ChannelContext {
  sql: postgres.Sql;
  mcp: Server;
  sessionId: () => number | null;
  projectPath: string;
  projectName: string;
  channelSource: "remote" | "local" | null;
  sessionName: () => string;
  botToken: string;
  botApiUrl: string;
}
```

---

## User Stories

1. **As a developer adding a new MCP tool**, I find all tools in `channel/tools.ts` ≤300 lines, not buried at line 638 of a 1320-line file.
2. **As a developer debugging a permission timeout**, I read `channel/permissions.ts` end-to-end without jumping to status/telegram/session sections.
3. **As a developer writing tests**, I instantiate `StatusManager` with a mock context and assert Telegram calls without starting a real MCP server.
4. **As a developer onboarding**, I read `channel/index.ts` (~80 lines) to understand the full process flow.

---

## Acceptance Criteria

- [ ] Each new module ≤300 lines
- [ ] No module-level mutable state outside `channel/index.ts`
- [ ] `channel/telegram.ts` is a pure leaf module (no imports from other `channel/` modules)
- [ ] `remember`, `recall`, `forget`, `search_project_context` tool handlers delegate to `memory/long-term.ts` (no raw SQL)
- [ ] All existing behaviour preserved: auto-approve rules, permission polling, status timers, LISTEN/NOTIFY, heartbeat, graceful shutdown
- [ ] `bun run channel.ts` continues to work identically

---

## Technical Approach

**Phase 1** — Extract `channel/telegram.ts` (pure functions, safest, no deps).  
**Phase 2** — Extract `channel/status.ts` (`StatusManager` class, resolves bidirectional coupling by co-location).  
**Phase 3** — Extract `channel/permissions.ts` (`PermissionHandler` with private methods `parseInput`, `buildDetail`, `buildPreview`, `sendPermissionMessage`, `pollForResponse`).  
**Phase 4** — Extract `channel/tools.ts`, replace inline `embed()` + SQL in `remember`/`recall`/`search_project_context` with calls to `memory/long-term.ts`.  
**Phase 5** — Extract `channel/session.ts`.  
**Phase 6** — Extract `channel/poller.ts`.  
**Phase 7** — Write `channel/index.ts`, shrink `channel.ts` to shim.

### PermissionHandler sketch

```ts
class PermissionHandler {
  constructor(private ctx: ChannelContext, private status: StatusManager) {}

  async handle(requestId: string, rawInput: unknown): Promise<string> {
    const { toolName, toolInput, description } = this.parseInput(requestId, rawInput);
    const detail = this.buildDetail(toolName, toolInput);
    const preview = await this.buildPreview(toolName, toolInput);
    await this.sendPermissionMessage(requestId, toolName, detail, preview);
    return this.pollForResponse(requestId);
  }

  private parseInput(...) { ... }
  private buildDetail(...) { ... }
  private async buildPreview(...) { ... }
  private async sendPermissionMessage(...) { ... }
  private async pollForResponse(requestId: string, timeoutMs = 120_000): Promise<string> { ... }
}
```

### StatusManager sketch

```ts
class StatusManager {
  private state: StatusState = { type: "idle" };

  async sendStatusMessage(chatId: number, text: string): Promise<void> { ... }
  async updateStatus(chatId: number, text: string, diff?: string): Promise<void> { ... }
  async deleteStatusMessage(chatId: number): Promise<void> { ... }
  startTyping(chatId: number): void { ... }
  stopTyping(chatId: number): void { ... }
}
```

---

## Files

**Created:** `channel/index.ts`, `channel/session.ts`, `channel/status.ts`, `channel/telegram.ts`, `channel/permissions.ts`, `channel/tools.ts`, `channel/poller.ts`

**Modified:** `channel.ts` — reduced to 3-line shim (`import "./channel/index.ts"`)

**Unchanged:** Everything outside `channel/`

---

## Out of Scope

- Adding new MCP tools
- Changing permission UX or LISTEN/NOTIFY behaviour
- Refactoring `sessions/manager.ts` or `memory/long-term.ts`
- Unit test authorship (see `unit-tests` PRD)

---

## Dependencies

- `memory/long-term.ts` must export `searchProjectContext()` — add if missing (2-line change)
- No dependency on `service-layer` PRD; can be implemented independently

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Module-level mutable state accidentally shared across modules | Medium | All mutable state inside ChannelContext or class instances |
| `channel.ts` shim breaks invocation by MCP config | Low | Keep root `channel.ts` as re-export shim, test before removing |
| Import cycle if `telegram.ts` imports from `channel/` | Low | `telegram.ts` is a pure leaf module, enforce in review |
| `markDisconnected` must fire on multiple POSIX signals | Medium | `index.ts` shutdown hook explicitly calls `session.markDisconnected()` |

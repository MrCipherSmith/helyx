# PRD: Security Defaults

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** High  
**Effort:** M  

---

## Overview

Three interlocking security weaknesses exist in the current codebase: (1) an empty `ALLOWED_USERS` list silently permits all Telegram users to control the bot, (2) the Docker volume layout mounts the entire `$HOME` directory read-only into the container, and (3) `channel.ts` reconstructs raw Telegram API calls at 11 call sites instead of delegating to a shared client module.

---

## Problem

### 1. ALLOWED_USERS fail-open behavior

**Files:** `bot/access.ts:12–14`, `main.ts:101–103`, `config.ts:4–7`

`accessMiddleware` contains an explicit "allow everyone" path when `ALLOWED_USERS` is empty:

```ts
// bot/access.ts:12-14
if (CONFIG.ALLOWED_USERS.length === 0) {
  return next();
}
```

`main.ts` emits only a `console.warn` and continues booting. The bot becomes fully accessible to any Telegram user who discovers its username — and this bot controls host processes, reads `$HOME`, and executes shell commands via Claude Code.

### 2. Broad volume mounts

**File:** `docker-compose.yml:25`

The mount `${HOME}:/host-home:ro` exposes the operator's entire home directory inside the container. It currently serves two purposes:
- `mcp/dashboard-api.ts:18` — `hostToContainerPath()` maps host project paths via `/host-home` for the git browser API
- `channel.ts:243` — reads `$HOME` to locate Claude config (already served by `.claude:/host-claude-config`)

Any path traversal bug or overly permissive git API endpoint could leak SSH keys, credentials, or shell history.

### 3. Scattered Telegram API client in channel.ts

**File:** `channel.ts` lines 331, 654, 731, 751, 826, 918, 930, 968, 1049, 1081, 1140

`channel.ts` reads `process.env.TELEGRAM_BOT_TOKEN` and constructs raw `fetch()` calls to `https://api.telegram.org/bot${token}/...` at 11 separate sites. Each call site has different error handling (most use bare `.catch(() => {})`).

---

## Solution

1. **ALLOWED_USERS fail-fast** — process exits at startup unless `ALLOWED_USERS` is set or `ALLOW_ALL_USERS=true` is explicit.
2. **Volume minimization** — replace `${HOME}:/host-home:ro` with `${HOST_PROJECTS_DIR}:/host-projects:ro`.
3. **Telegram client centralization** — extract all raw Telegram API calls from `channel.ts` into a single `utils/channel-telegram.ts` module.

---

## User Stories

1. **As an operator**, I want the bot to refuse to start if `ALLOWED_USERS` is not set, so a misconfigured deployment never accidentally exposes my Claude Code sessions.
2. **As an operator**, I want an explicit `ALLOW_ALL_USERS=true` opt-out, so the intent is documented in the env file.
3. **As an operator**, I want the container's access to my home directory limited to the paths the bot actually needs, so a container escape cannot read my SSH keys.
4. **As a developer**, I want all Telegram API calls in `channel.ts` to go through one client module, so retry logic and error handling are consistent.

---

## Acceptance Criteria

- [ ] `main.ts` calls `process.exit(1)` with a clear error message when `ALLOWED_USERS` is empty and `ALLOW_ALL_USERS` is not `"true"`
- [ ] `bot/access.ts` removes the fail-open branch; the only open path is gated by `CONFIG.ALLOW_ALL_USERS`
- [ ] `config.ts` exports `ALLOW_ALL_USERS: boolean`
- [ ] `.env.example` documents `ALLOW_ALL_USERS` with a warning comment
- [ ] `docker-compose.yml` removes `${HOME}:/host-home:ro` and adds `${HOST_PROJECTS_DIR:-${HOME}/bots}:/host-projects:ro`
- [ ] `mcp/dashboard-api.ts` `hostToContainerPath()` works correctly with the new mount point
- [ ] All Telegram HTTP calls in `channel.ts` are delegated to a single `TelegramClient` instance
- [ ] Bot starts successfully with a valid `.env` containing `ALLOWED_USERS`
- [ ] Bot exits at startup (exit code 1) when `ALLOWED_USERS` is absent and `ALLOW_ALL_USERS` is not set

---

## Technical Approach

### 1. ALLOWED_USERS fail-fast

**`config.ts`** — add:
```ts
ALLOW_ALL_USERS: process.env.ALLOW_ALL_USERS === "true",
```

**`main.ts:101–103`** — replace warn with:
```ts
if (CONFIG.ALLOWED_USERS.length === 0 && !CONFIG.ALLOW_ALL_USERS) {
  console.error(
    "[main] FATAL: ALLOWED_USERS is not set and ALLOW_ALL_USERS is not 'true'.\n" +
    "  Set ALLOWED_USERS=<your_telegram_id> in .env, or set ALLOW_ALL_USERS=true to explicitly allow all users."
  );
  process.exit(1);
}
if (CONFIG.ALLOW_ALL_USERS) {
  console.warn("[main] ⚠ ALLOW_ALL_USERS=true — bot is open to ALL Telegram users");
}
```

**`bot/access.ts:12–14`** — replace fail-open:
```ts
// Before
if (CONFIG.ALLOWED_USERS.length === 0) { return next(); }
// After
if (CONFIG.ALLOW_ALL_USERS) { return next(); }
```

### 2. Volume mount minimization

**`docker-compose.yml`** — swap line 25:
```yaml
# Remove:
- ${HOME}:/host-home:ro
# Add:
- ${HOST_PROJECTS_DIR:-${HOME}/bots}:/host-projects:ro
```

Update environment block — remove `HOST_HOME: ${HOME}`, add `HOST_PROJECTS_DIR: ${HOST_PROJECTS_DIR:-${HOME}/bots}`.

**`mcp/dashboard-api.ts`** — update `hostToContainerPath()`:
```ts
const HOST_PROJECTS_DIR = process.env.HOST_PROJECTS_DIR ?? (homedir() + "/bots");
function hostToContainerPath(hostPath: string): string {
  if (hostPath.startsWith(HOST_PROJECTS_DIR)) {
    return "/host-projects" + hostPath.slice(HOST_PROJECTS_DIR.length);
  }
  // Fallback for legacy HOST_HOME mount during transition
  const HOST_HOME = process.env.HOST_HOME ?? homedir();
  if (process.env.HOST_HOME && hostPath.startsWith(HOST_HOME)) {
    return "/host-home" + hostPath.slice(HOST_HOME.length);
  }
  return hostPath;
}
```

### 3. Telegram client centralization

Create **`utils/channel-telegram.ts`**:
```ts
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

async function call(method: string, body: Record<string, unknown>): Promise<void> {
  if (!BASE) return;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) process.stderr.write(`[channel-tg] ${method} failed: ${res.status}\n`);
  } catch (err) {
    process.stderr.write(`[channel-tg] ${method} error: ${err}\n`);
  }
}

export const channelTelegram = {
  sendMessage: (chatId: number | string, text: string, extra?: Record<string, unknown>) =>
    call("sendMessage", { chat_id: Number(chatId), text, ...extra }),
  editMessageText: (chatId: number | string, messageId: number, text: string, extra?: Record<string, unknown>) =>
    call("editMessageText", { chat_id: Number(chatId), message_id: messageId, text, ...extra }),
  deleteMessage: (chatId: number | string, messageId: number) =>
    call("deleteMessage", { chat_id: Number(chatId), message_id: messageId }),
  sendChatAction: (chatId: number | string, action: string) =>
    call("sendChatAction", { chat_id: Number(chatId), action }),
};
```

Replace all 11 `process.env.TELEGRAM_BOT_TOKEN` reads in `channel.ts` with imports from `channel-telegram.ts`.

---

## Files

**Modified:**
- `config.ts` — add `ALLOW_ALL_USERS`
- `main.ts` — fail-fast at lines 101–103
- `bot/access.ts` — remove fail-open branch
- `docker-compose.yml` — swap volume mount; update environment block
- `mcp/dashboard-api.ts` — update `hostToContainerPath()`
- `channel.ts` — consolidate token reads and raw fetch calls
- `.env.example` — document `ALLOW_ALL_USERS`, `HOST_PROJECTS_DIR`

**New:**
- `utils/channel-telegram.ts` — centralized Telegram client for channel subprocess

---

## Out of Scope

- Migrating `bot/commands/*.ts` Telegram calls (they already use grammY with `autoRetry`)
- Rate limiting on internal proxy endpoints
- MFA for dashboard login

---

## Dependencies

- Document `ALLOW_ALL_USERS` in release notes before deploying fail-fast, to avoid surprising existing open deployments
- Set `HOST_PROJECTS_DIR` in production `.env` before removing `HOST_HOME` mount, or keep fallback during a transition release
- The `env-validation` PRD should be implemented in parallel

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Operators relying on open-access mode are broken by fail-fast | Medium | `ALLOW_ALL_USERS=true` is a one-line fix; document in migration guide |
| `HOST_PROJECTS_DIR` not set → git browser breaks for projects outside `$HOME/bots` | Medium | Keep `/host-home` fallback during transition release |
| Centralizing channel.ts Telegram calls misses an edge case (parse_mode, inline keyboards) | Low | Audit all 11 call sites; add integration test for permission request flow |

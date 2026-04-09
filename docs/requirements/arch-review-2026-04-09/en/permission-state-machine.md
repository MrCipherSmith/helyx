# PRD: Permission State Machine

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** High  
**Effort:** M  

---

## Overview

Formalize the permission lifecycle with an explicit `status` column and state machine. Add idempotent callback handling, timeout persistence, and explicit expired state.

---

## Problem

**Current state is implicit:**
- `permission_requests` has no `status` column — state is inferred from `response IS NULL` vs not
- Timeout path (`channel.ts:504`) never writes `expired` to DB — a crash mid-timeout leaves rows as `pending` forever, appearing in the dashboard and `/pending` endpoint

**Race conditions and duplicates:**
- `bot/callbacks.ts:109–111`: `UPDATE ... WHERE id = $id AND chat_id = $chatId` — no idempotency guard on `status`. Telegram can deliver the same callback twice (network retry), resulting in duplicate processing
- `channel.ts:462–517`: ad-hoc polling loop with a local `resolved` boolean flag — not persisted, lost on restart

**Stale state leaks:**
- `dashboard-api.ts:623`: `WHERE response IS NULL` — returns 404 on already-answered requests instead of returning the current state
- Expired permissions appear as pending indefinitely if the process restarts before cleanup

---

## Solution

Add a `status` column (`pending | approved | rejected | expired`) to `permission_requests`. Centralize all state transitions through a `PermissionService`. Make all callback handlers idempotent via `status` check before update.

---

## State Machine

```
                  ┌──────────┐
         create   │  pending │
         ───────► │          │
                  └──────────┘
                    │   │   │
          allow ────┘   │   └──── timeout
          deny ─────────┘        │
               │                 ▼
               ▼           ┌──────────┐
         ┌──────────┐       │ expired  │
         │ approved │       └──────────┘
         └──────────┘
         ┌──────────┐
         │ rejected │
         └──────────┘
```

Transitions:
- `pending → approved` — user clicks Allow or Always Allow
- `pending → rejected` — user clicks Deny
- `pending → expired` — timeout fires (no user action within TTL)
- Any state → no further transition (terminal states)

---

## User Stories

1. **As a developer**, I want duplicate Telegram callbacks to be safely ignored so the permission is not double-processed.
2. **As a user**, I want timed-out permissions to show as "Expired" in the dashboard, not "Pending".
3. **As a developer**, I want the permission state to survive a process restart so no row gets stuck as `pending` forever.

---

## Acceptance Criteria

- [ ] `permission_requests` table has `status TEXT NOT NULL DEFAULT 'pending'` column
- [ ] All transitions go through `PermissionService.transition(id, newStatus)` — rejects invalid transitions
- [ ] `transition()` is idempotent: calling `approve` on an already-approved permission is a no-op (returns current state, no error)
- [ ] Timeout handler writes `status = 'expired'` to DB before the request is abandoned
- [ ] `GET /api/permissions` returns `status` field on each item
- [ ] Dashboard shows `expired` badge for expired permissions
- [ ] On startup, `pending` permissions older than `PERMISSION_TIMEOUT_MS` are bulk-expired (recovery after crash)
- [ ] Bot callback handler checks `status = 'pending'` before processing — silently ignores if already terminal

---

## Technical Approach

### DB Migration

```sql
ALTER TABLE permission_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
-- Backfill from existing response column
UPDATE permission_requests SET status = 'approved' WHERE response = 'allow';
UPDATE permission_requests SET status = 'rejected' WHERE response = 'deny';
UPDATE permission_requests SET status = 'expired'
  WHERE response IS NULL AND created_at < NOW() - INTERVAL '10 minutes';
CREATE INDEX idx_permissions_status ON permission_requests(status);
```

### `services/PermissionService.ts` (new)

```typescript
type PermissionStatus = "pending" | "approved" | "rejected" | "expired";

const VALID_TRANSITIONS: Record<PermissionStatus, PermissionStatus[]> = {
  pending: ["approved", "rejected", "expired"],
  approved: [],
  rejected: [],
  expired: [],
};

export class PermissionService {
  async transition(id: number, next: PermissionStatus): Promise<boolean> {
    const row = await sql`SELECT status FROM permission_requests WHERE id = ${id}`;
    if (!row[0]) return false;
    if (!VALID_TRANSITIONS[row[0].status].includes(next)) return false; // idempotent: same status = no-op
    await sql`UPDATE permission_requests SET status = ${next}, updated_at = NOW() WHERE id = ${id}`;
    return true;
  }
}
```

### `bot/callbacks.ts`

Wrap all callback handlers with idempotency check:
```typescript
const current = await sql`SELECT status FROM permission_requests WHERE id = ${permId}`;
if (current[0]?.status !== "pending") {
  await ctx.answerCallbackQuery("Already handled");
  return;
}
await permissionService.transition(permId, "approved");
```

### Startup recovery (`main.ts`)

```typescript
// On startup: expire stale pending permissions
await sql`
  UPDATE permission_requests SET status = 'expired'
  WHERE status = 'pending' AND created_at < NOW() - INTERVAL '${PERMISSION_TIMEOUT_MINUTES} minutes'
`;
```

---

## Files

- DB migration (new migration file in `migrations/`)
- `services/PermissionService.ts` (new)
- `bot/callbacks.ts` — idempotency guard
- `channel.ts` (~line 504) — timeout writes `expired` via PermissionService
- `mcp/dashboard-api.ts` (~line 623) — include `status` in response
- `main.ts` — startup recovery for stale permissions
- `dashboard/webapp/src/components/SessionMonitor.tsx` — show expired badge

---

## Out of Scope

- Permission expiry notifications to user (separate feature)
- Permission history analytics changes (already implemented in v1.16)

---

## Dependencies

- DB migration required
- Should be implemented before `channel-refactor` (PermissionService becomes the clean boundary)

---

## Risks

- Migration must backfill `status` correctly from existing `response` values — verify backfill SQL before running on production

# PRD: Cleanup Jobs Refactoring

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** Medium  
**Effort:** S  

---

## Overview

Split the monolithic `cleanup()` function in `main.ts` into separate, isolated, named jobs with individual error handling, timing metrics, and a dry-run mode.

---

## Problem

`main.ts:10–91` contains a single `cleanup()` function run every hour via `setInterval`. It performs 12+ distinct DELETE/UPDATE operations sequentially:

- Short-lived queue cleanup (24h TTL)
- Log rotation (7d)
- Session archival (configurable TTL)
- Memory TTL per type (fact 90d, summary 60d, etc.)
- Stale session marking (inactive after disconnect timeout)
- Orphan CLI session deletion

**Issues:**
- A single error in any step (`catch (err) => console.error`) aborts all remaining cleanup steps silently
- No per-job timing — impossible to know which step is slow
- No dry-run mode — cannot audit what would be deleted before executing
- Mixed concerns with wildly different TTLs (24h vs 180d) in the same function
- Adding a new cleanup type requires editing a large monolithic function

---

## Solution

Extract each cleanup concern into its own named job function. Run them independently with individual try/catch, timing, and logging. Add `DRY_RUN=true` env var support.

---

## User Stories

1. **As a developer**, I want to run `DRY_RUN=true bun run cleanup` to see what rows would be deleted without actually deleting them.
2. **As an operator**, I want each cleanup job to log how many rows it affected and how long it took.
3. **As a developer**, if memory cleanup fails, I want session cleanup to still run (isolated error handling).

---

## Acceptance Criteria

- [ ] Each cleanup concern is a separate named async function
- [ ] Each job has its own `try/catch` — failure of one does not skip others
- [ ] Each job logs: `{ job, rowsAffected, durationMs }` on completion
- [ ] `DRY_RUN=true` env var makes all jobs SELECT instead of DELETE/UPDATE and logs what would be affected
- [ ] Cleanup still runs on the same schedule (hourly `setInterval`)
- [ ] All existing TTL behavior preserved

---

## Technical Approach

### New structure: `cleanup/jobs.ts`

```typescript
export type CleanupJob = {
  name: string;
  run: (dryRun: boolean) => Promise<{ rowsAffected: number }>;
};

export const messageQueueCleanup: CleanupJob = {
  name: "message-queue",
  async run(dryRun) {
    if (dryRun) {
      const rows = await sql`SELECT COUNT(*) FROM message_queue WHERE created_at < NOW() - INTERVAL '24 hours'`;
      return { rowsAffected: Number(rows[0].count) };
    }
    const res = await sql`DELETE FROM message_queue WHERE created_at < NOW() - INTERVAL '24 hours'`;
    return { rowsAffected: res.count };
  },
};

// Similar: sessionArchival, memoryCleanup (per type), logRotation, staleSessionMarker, orphanCliCleanup
```

### `cleanup/runner.ts`

```typescript
import { allJobs } from "./jobs";

export async function runCleanup(dryRun = false) {
  const log = logger.child({ component: "cleanup", dryRun });
  for (const job of allJobs) {
    const start = Date.now();
    try {
      const { rowsAffected } = await job.run(dryRun);
      log.info({ job: job.name, rowsAffected, durationMs: Date.now() - start });
    } catch (err) {
      log.error({ job: job.name, err }, "Cleanup job failed");
    }
  }
}
```

### `main.ts`

Replace the inline `cleanup()` with:
```typescript
import { runCleanup } from "./cleanup/runner";
const DRY_RUN = process.env.DRY_RUN === "true";
setInterval(() => runCleanup(DRY_RUN), 60 * 60 * 1000);
```

### Job list

| Job name | TTL | Table |
|---|---|---|
| `message-queue` | 24h | `message_queue` |
| `logs` | 7d | `logs` |
| `archived-messages` | `ARCHIVE_TTL_DAYS` | `messages` |
| `archived-permissions` | `ARCHIVE_TTL_DAYS` | `permission_requests` |
| `memory-fact` | 90d | `memories` (type=fact) |
| `memory-summary` | 60d | `memories` (type=summary) |
| `memory-decision` | 180d | `memories` (type=decision) |
| `memory-note` | 30d | `memories` (type=note) |
| `memory-project-context` | 180d | `memories` (type=project_context) |
| `stale-sessions` | disconnect timeout | `sessions` |
| `orphan-cli-sessions` | — | `sessions` (source=local) |

---

## Files

- `cleanup/jobs.ts` (new) — all job implementations
- `cleanup/runner.ts` (new) — orchestrator with error isolation and timing
- `main.ts` — replace inline `cleanup()` with `runCleanup()`
- `package.json` — add script `"cleanup": "DRY_RUN=true bun run cleanup/runner.ts"` for manual dry-run

---

## Out of Scope

- External job scheduler (cron, BullMQ) — `setInterval` is sufficient for single-process
- Alerting on cleanup failures — covered by structured logging PRD

---

## Dependencies

- Pairs well with structured logging PRD (log output from jobs benefits from pino)

---

## Risks

- Low — this is a pure refactor of existing logic. No behavior changes, only structure and error isolation.
- Verify all TTL constants are preserved exactly during extraction

# Managed Review Report — flow 065

Four independent reviewers (review-logic, review-backend, review-architecture,
review-testing-practices, all dispatched via general-purpose fallback since
none have native agent types in this runtime) reviewed the full working-tree
diff for flow 065 against PR #116
(https://github.com/MrCipherSmith/helyx/pull/116).

Verdict: APPROVE_WITH_SUGGESTIONS. 0 blockers. 4 majors (3 fixed before merge,
one — duplicated write-path abstraction — left as a tracked, out-of-P0-scope
fast-follow). 6 minors, 3 infos. Full findings below; disposition recorded
separately via keryx review complete.

```keryx:findings
[
  {
    "id": "F-001",
    "severity": "major",
    "file": "channel/poller.ts",
    "line": 365,
    "problem": "message_queue.claimed_at (migration v55) is set on claim but never reclaimed on staleness; a real process crash between claim and mcp.notification settling leaves a row permanently claimed_at IS NOT NULL / delivered=false, invisible to both the poller's re-claim query and scripts/supervisor.ts's checkUnansweredMessages rescue guard (which the pre-fix delivered=true-on-claim behavior had accidentally still let through).",
    "impact": "A message can be lost with zero automatic recovery path for exactly the crash scenario flow 065 P0-C exists to fix.",
    "suggested_fix": "Exclude stale (>2min) claimed_at rows from checkUnansweredMessages's NOT EXISTS guard so the pre-existing rescue path still catches a genuinely abandoned claim.",
    "evidence": "Independently raised by review-architecture (F-002), review-logic (F-001), and review-backend (part of F-001's framing); confirmed by reading channel/poller.ts:365-390, memory/db.ts:1066-1090 migration v55, and scripts/supervisor.ts's pre-existing (unmodified by this flow) unanswered-message guard.",
    "confidence": "high",
    "reviewer": "review-architecture,review-logic,review-backend",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "channel/poller.ts:365-390 (claim query)",
        "scripts/supervisor.ts:1843-1848 (rescue guard, pre-existing)"
      ],
      "enumeration_method": "read every write/read site of message_queue.claimed_at and delivered across channel/poller.ts, channel/status.ts, scripts/supervisor.ts, scripts/admin-daemon.ts (grep for claimed_at)"
    }
  },
  {
    "id": "F-002",
    "severity": "major",
    "file": "channel/recovery.ts",
    "line": 97,
    "problem": "deliverPendingReplies's recovery query excluded status='sending' by design; a real process crash between channel/tools.ts's premark ('sending') and markPendingOutcome leaves the row permanently invisible to both the periodic recovery worker and bot-startup recovery.",
    "impact": "Worse than pre-fix behavior for this narrow window: before, a restart's delivered_at IS NULL query would have picked the row back up; after, nothing ever does.",
    "suggested_fix": "Include status='sending' rows once they pass the same 30s created_at age bound already applied to pending/failed/partial.",
    "evidence": "Independently raised by review-logic (F-002) and review-backend (F-001); confirmed by reading channel/recovery.ts:97-105 and channel/tools.ts:541-543.",
    "confidence": "high",
    "reviewer": "review-logic,review-backend",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "channel/recovery.ts:97-105 (deliverPendingReplies query)"
      ],
      "enumeration_method": "single query is the sole read path for pending_replies recovery; grep confirms no other consumer of status='sending'"
    }
  },
  {
    "id": "F-003",
    "severity": "major",
    "file": "utils/telegram-rate-budget.ts",
    "line": 267,
    "problem": "refreshNow()'s dedup was removed (needed for AC1's conservation semantics), which let scheduleRetry's own auto-fired backoff attempts pile up multiple concurrent real leaseBudget calls per waiting caller when a single lease round trip takes longer than retryBackoffMs (plausible under DB latency, up to LEASE_TIMEOUT_MS=3000ms).",
    "impact": "Risks DB pool pressure and can grant a subprocess more of the shared budget than its real demand in that instant, in tension with AC3's fairness guarantee and the flow's own goal of stopping self-inflicted starvation.",
    "suggested_fix": "Add a dedicated in-flight guard scoped only to scheduleRetry's own auto-fired attempts, leaving explicit/caller-driven refreshNow() calls un-deduped.",
    "evidence": "Raised by review-backend (F-002); confirmed by reading utils/telegram-rate-budget.ts's scheduleRetry/refreshNow interaction and LEASE_TIMEOUT_MS/retryBackoffMs values.",
    "confidence": "medium",
    "reviewer": "review-backend",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "utils/telegram-rate-budget.ts:290-303 (scheduleRetry)"
      ],
      "enumeration_method": "scheduleRetry is the only auto-firing call site of refreshNow(); grep confirms no other setTimeout/setInterval driving a lease attempt"
    }
  },
  {
    "id": "F-004",
    "severity": "major",
    "file": "channel/poller.ts",
    "line": 365,
    "problem": "The delivered/claimed_at reset-and-claim write-path for message_queue is hand-written independently at 5 call sites across 3 modules (channel/poller.ts, channel/status.ts, scripts/supervisor.ts, scripts/admin-daemon.ts) with no shared helper.",
    "impact": "This exact class of bug (divergent duplicate SQL against message_queue) is what flow 065's own P0-C fix (the supervisor rescue INSERT/UPSERT bug) already demonstrated; a future call site that resets/claims the row and forgets claimed_at reproduces it invisibly.",
    "suggested_fix": "Extract shared resetQueueRowToRetryable/claimQueueRows helpers and route all write sites through them. Flagged as a fast-follow, not blocking this flow's P0 delivery.",
    "evidence": "review-architecture F-001; grep confirms the write pattern is repeated, not shared, across the 5 named sites.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "channel/poller.ts:174",
        "channel/poller.ts:525",
        "channel/status.ts:766",
        "scripts/admin-daemon.ts:784",
        "scripts/supervisor.ts:1917-1922"
      ],
      "enumeration_method": "grep for `SET delivered` and `SET claimed_at` across channel/ and scripts/"
    }
  },
  {
    "id": "F-005",
    "severity": "minor",
    "file": "channel/tools.ts",
    "line": 545,
    "problem": "pending_replies.status write-path is also duplicated across 3 modules (channel/tools.ts, channel/recovery.ts, mcp/server.ts) with no shared helper, though all three use consistent enum literals today.",
    "impact": "Same missing-abstraction shape as F-004 but lower immediate risk since no divergence has occurred yet.",
    "suggested_fix": "A shared insertFailedPendingReply/setPendingReplyStatus helper would let mcp/server.ts and channel/tools.ts avoid re-deriving the schema independently. Opportunistic, not urgent.",
    "evidence": "review-architecture F-003.",
    "confidence": "medium",
    "reviewer": "review-architecture"
  },
  {
    "id": "F-006",
    "severity": "info",
    "file": "memory/db.ts",
    "line": 1027,
    "problem": "pending_replies.status (explicit TEXT+CHECK enum) and message_queue.claimed_at (nullable timestamp encoding state implicitly) use two different state-machine idioms for structurally the same 'claimed vs confirmed' problem, since T6 and T10 ran concurrently without worktree isolation and each picked a different representation.",
    "impact": "Not a functional problem; a future reader learns two conventions in the same migrations file a few versions apart.",
    "suggested_fix": "If message_queue ever needs a third real state, consider migrating it to the same TEXT+CHECK idiom for consistency.",
    "evidence": "review-architecture F-004.",
    "confidence": "medium",
    "reviewer": "review-architecture"
  },
  {
    "id": "F-007",
    "severity": "minor",
    "file": "channel/recovery.ts",
    "line": 116,
    "problem": "Recovery of a 'partial' reply resends the full original text (single text column per row), duplicating the already-delivered anchor chunk.",
    "impact": "Operator receives the successfully-delivered anchor content a second time on any partial-failure recovery. Real but low-severity UX gap; AC7 only requires state correctness, not selective resend.",
    "suggested_fix": "Track per-chunk delivery state (e.g. a JSON array of chunk texts + sent flags) so recovery resends only unsent chunks, or explicitly document the duplicate-risk simplification.",
    "evidence": "review-logic F-003.",
    "confidence": "medium",
    "reviewer": "review-logic"
  },
  {
    "id": "F-008",
    "severity": "minor",
    "file": "memory/db.ts",
    "line": 1039,
    "problem": "Migration v54's guarded ADD CONSTRAINT (IF NOT EXISTS via pg_constraint check) has a non-atomic check-then-act window: two concurrent runMigrations() calls (e.g. a rolling restart briefly running two bot containers) could race on the ALTER TABLE.",
    "impact": "Low practical risk (single bot container in production today); the losing transaction rolls back cleanly and self-heals on the next attempt, so this is not corrupting.",
    "suggested_fix": "Catch Postgres error code 42710 (duplicate_object) around the ALTER TABLE and treat it as success, or add a comment acknowledging the accepted risk the same way v55 does for its own gap.",
    "evidence": "review-backend F-003.",
    "confidence": "medium",
    "reviewer": "review-backend"
  },
  {
    "id": "F-009",
    "severity": "minor",
    "file": "memory/db.ts",
    "line": 420,
    "problem": "idx_pending_replies_undelivered (partial index on delivered_at IS NULL) is superseded by every query in this diff now filtering on status instead, but is still maintained on every write.",
    "impact": "Minor write overhead; no correctness issue.",
    "suggested_fix": "Consider dropping the superseded index in a future migration, or leave a comment noting another consumer still reads it if one does.",
    "evidence": "review-backend F-004.",
    "confidence": "low",
    "reviewer": "review-backend"
  },
  {
    "id": "F-010",
    "severity": "minor",
    "file": "tests/unit/telegram-rate-budget.test.ts",
    "line": 338,
    "problem": "Doc comments referenced the removed ensureStarted() function name after utils/telegram-rate-budget.ts's refactor inlined that logic into acquire()'s firstEver branch.",
    "impact": "Documentation-only; no functional impact.",
    "suggested_fix": "Update the comment to reference the actual mechanism.",
    "evidence": "review-backend F-005. FIXED before merge (T4 review-fix round).",
    "confidence": "high",
    "reviewer": "review-backend"
  },
  {
    "id": "F-011",
    "severity": "info",
    "file": "tests/unit/telegram-rate-budget.test.ts",
    "line": 400,
    "problem": "AC3's test title says 'not starved by concurrently-idle allowances,' but under the fixed on-demand design an allowance that never calls acquire() cannot generate any load at all, so idle instances cannot literally 'contend' by construction.",
    "impact": "Documentation/naming precision issue only; review-testing-practices independently verified via revert-and-rerun that the test still catches the original starvation regression.",
    "suggested_fix": "Optional: retitle to reflect what the test now actually proves.",
    "evidence": "review-testing-practices F-001, verified empirically by reverting utils/telegram-rate-budget.ts to pre-fix HEAD and confirming AC1/AC2/AC3 all fail as expected.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "F-012",
    "severity": "minor",
    "file": "tests/unit/stop-hook-turn-closed-gate.test.ts",
    "line": 73,
    "problem": "AC6's test only asserts pg_notify count is 0 on a failed send; it never asserts the INSERT INTO pending_replies ... status='failed' write that lets the recovery worker retry the failed part was actually issued.",
    "impact": "A regression that stopped persisting the failed part while keeping the early return would pass this test unnoticed, silently reintroducing a 'lost forever' failure mode.",
    "suggested_fix": "Add an assertion that the failed-status INSERT was issued, alongside the existing pg_notify assertion.",
    "evidence": "review-testing-practices F-002.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "F-013",
    "severity": "info",
    "file": "tests/unit/telegram-rate-budget.test.ts",
    "line": 457,
    "problem": "AC3's fairness test spends ~2.5s of real wall-clock time per run, the largest single contributor to this batch's runtime, because the refill computation is genuinely time-based against real Postgres.",
    "impact": "Already well-justified in the test's own comment (an earlier real-timer version was flakier/slower); flagged only for CI-budget awareness as more DB-backed timing tests accumulate.",
    "suggested_fix": "No action required now; reasonable tradeoff.",
    "evidence": "review-testing-practices F-003.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  }
]
```

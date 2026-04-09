# PRD: Unit Test Coverage for Critical Flows

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** Medium  
**Effort:** L  

---

## Overview

Add unit tests for session lifecycle, permission flow, and memory reconciliation. Currently the project has only Playwright e2e tests — zero unit tests exist.

---

## Problem

- **Zero unit tests** — `tests/e2e/` contains Playwright API + dashboard tests only
- Session lifecycle transitions (active → inactive → terminated) are untested at the unit level; bugs surface only in production
- Permission flow (pending → approved/denied/expired) has race condition potential with no regression coverage
- Memory reconciliation (ADD/UPDATE/NOOP/DELETE decisions from LLM + vector search) is complex and completely untested
- Refactoring any of these areas is high-risk without a safety net

---

## Solution

Add a Bun test suite (`bun test`) for the three most critical domains. Use in-memory or mock implementations where needed to keep tests fast and isolated.

---

## User Stories

1. **As a developer**, when I refactor `channel.ts` I want to run `bun test` and get immediate feedback on session state transitions.
2. **As a developer**, when I change permission callback logic I want a test that catches duplicate callback processing.
3. **As a developer**, when I modify memory reconciliation prompts I want tests that verify ADD/UPDATE/NOOP decisions given known inputs.

---

## Acceptance Criteria

- [ ] `bun test` runs all unit tests without requiring a running database or Telegram
- [ ] Session lifecycle: test state transitions (active→inactive, inactive→terminated, reconnect→active)
- [ ] Permission flow: test idempotency (same callback called twice → second is no-op), timeout expiry, response handling
- [ ] Memory reconciliation: test decision outputs for known (input, similar_memories) pairs with mocked LLM
- [ ] Coverage report available via `bun test --coverage`
- [ ] Unit tests complete in < 10 seconds (fast, no I/O)
- [ ] Existing e2e tests continue to pass unchanged

---

## Technical Approach

### Test runner

Bun has a built-in test runner (`bun test`) compatible with Jest API. No additional packages needed.

### File structure

```
tests/
  unit/
    session-lifecycle.test.ts
    permission-flow.test.ts
    memory-reconciliation.test.ts
  e2e/                          ← existing, unchanged
```

### 1. Session Lifecycle Tests (`session-lifecycle.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";

describe("Session state transitions", () => {
  test("active → inactive on disconnect", () => { ... });
  test("inactive → active on reconnect", () => { ... });
  test("active → terminated on explicit end", () => { ... });
  test("cannot transition terminated → active", () => { ... });
  test("local session cleaned up on orphan", () => { ... });
});
```

Extract transition logic from `channel.ts` / `sessions/manager.ts` into pure functions testable without DB.

### 2. Permission Flow Tests (`permission-flow.test.ts`)

```typescript
describe("Permission callbacks", () => {
  test("allow callback sets response = 'allow'", () => { ... });
  test("deny callback sets response = 'deny'", () => { ... });
  test("duplicate callback is idempotent", () => { ... });
  test("expired permission rejects late callback", () => { ... });
  test("always-allow writes pattern to settings", () => { ... });
});
```

Mock the DB (`postgres` tag) and file system. Test pure permission decision logic.

### 3. Memory Reconciliation Tests (`memory-reconciliation.test.ts`)

```typescript
describe("Memory reconciliation", () => {
  test("ADD when no similar memories found", async () => { ... });
  test("UPDATE when similarity > threshold and LLM says UPDATE", async () => { ... });
  test("NOOP when identical content found", async () => { ... });
  test("DELETE when LLM identifies contradiction", async () => { ... });
  test("fallback to plain remember() when LLM unavailable", async () => { ... });
});
```

Mock `@anthropic-ai/sdk` and the pgvector similarity search. Feed known inputs, assert decision.

### 4. `package.json` scripts

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit/",
    "test:e2e": "playwright test",
    "test:coverage": "bun test --coverage"
  }
}
```

---

## Files

- `tests/unit/session-lifecycle.test.ts` (new)
- `tests/unit/permission-flow.test.ts` (new)
- `tests/unit/memory-reconciliation.test.ts` (new)
- `package.json` — update scripts
- `sessions/manager.ts` — extract pure transition functions for testability (if needed)
- `memory/summarizer.ts` — extract reconcile decision logic for testability (if needed)

---

## Out of Scope

- 100% code coverage — focus on critical paths only
- E2E test expansion (covered by existing Playwright suite)
- Load / concurrency tests (separate PRD)
- Bot command handler tests (lower priority)

---

## Dependencies

- No new packages — Bun test runner built-in
- Existing: `@anthropic-ai/sdk`, `postgres` (mock in tests)

---

## Risks

- Session and permission logic is currently interleaved in `channel.ts` — may require extraction of pure functions before tests can be written cleanly. This is also the motivation for the `channel-refactor` PRD.
- LLM-dependent reconciliation tests require careful mock design to avoid testing the mock instead of the logic

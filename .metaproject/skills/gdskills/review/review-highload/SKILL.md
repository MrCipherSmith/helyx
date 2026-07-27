---
name: review-highload
description: |
  Use when: reviewing code that will run under high concurrency or high traffic —
  race conditions, connection pool exhaustion, cache invalidation, missing indexes,
  unbounded queues, missing backpressure, retry storms, idempotency gaps,
  hot-path blocking I/O, and distributed systems anti-patterns.
  Triggered by: "review highload", "review scalability", "highload review",
  "review concurrency", "review --highload", or dispatched by review-orchestrator.
  NOT for: frontend re-render performance (review-performance), general N+1 queries
  (review-performance), clean code style (review-clean-code), or NestJS module structure
  (review-architecture).
version: "1.0.0"
triggers:
  - "review highload"
  - "review scalability"
  - "highload review"
  - "review concurrency"
  - "review distributed"
  - "review --highload"
  - dispatched by review-orchestrator
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review: High-Load & Scalability

Specialized reviewer for **code that will run under significant concurrent load**.
Focuses on correctness under concurrency, resource contention, back-pressure, failure
modes at scale, and distributed systems invariants — not general performance profiling.

Reviews only changes introduced in the current branch (merge-base to HEAD).

---

## Workflow

```
High-Load Review Progress:
- [ ] Step 1: Read Job Context (if provided) — understand expected load profile
- [ ] Step 2: Determine git scope (merge-base)
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: Concurrency and race condition check
- [ ] Step 5: Resource management check (connections, threads, file handles, memory)
- [ ] Step 6: Caching and cache invalidation check
- [ ] Step 7: Database access patterns under load
- [ ] Step 8: Async processing and queue patterns
- [ ] Step 9: Retry, timeout, and circuit breaker patterns
- [ ] Step 10: Idempotency and distributed invariants
- [ ] Step 11: Emit findings in unified format
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit hash or range. Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document. Read before reviewing to understand expected RPS, SLA, and load profile. |
| `load_profile` | string | no | Optional hint: expected RPS, concurrent users, or traffic pattern. Adjusts severity of findings. |

---

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script to determine `BASE_SHA`, then collect the diff:

```bash
git diff --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

Review scope: **changes introduced in the current branch since merge-base only**.
Pre-existing problems in unchanged lines are out of scope unless the diff makes them worse.

---

## Iron Laws

1. **A race condition on shared mutable state is always a `blocker`.** There is no "it probably won't happen in practice" — race conditions manifest unpredictably under load.
2. **An unbounded resource (connection, goroutine, thread, queue, in-memory collection) that grows with request rate is always at least `major`.** Under load it will exhaust the resource.
3. **Missing retry idempotency is always a `blocker` where the operation has side effects.** A retried non-idempotent write is a data integrity bug.
4. **Blocking I/O on a thread/fiber that is shared with the event loop is always at least `major`.** One slow call blocks all concurrent requests on that thread.
5. **Architecture opinions without a named pattern violation and concrete load-related impact are `info` only.** State the failure mode, not just that "it could be better".

---

## Review Checklist

### Part A: Concurrency and Race Conditions

#### A1. Shared Mutable State

- [ ] Shared in-memory state (module-level variables, singleton fields, static properties) mutated from concurrent requests without a lock, mutex, or atomic operation
- [ ] Read-modify-write operations on shared counters, maps, or lists not wrapped in an atomic or transaction
- [ ] `Map` / `Set` / plain objects used as in-process caches mutated from concurrent async operations
- [ ] NestJS `DEFAULT`-scoped (singleton) service holding per-request state (e.g., `this.currentUser = ...`)

Flags:
- Singleton service holding mutable per-request state — **blocker**
- Read-modify-write on shared map/counter without atomicity — **blocker**
- Module-level mutable variable mutated from async handlers — **major**

#### A2. Double-Check and TOCTOU

- [ ] Check-then-act patterns where the condition can change between check and action: `if (!exists) insert` without a unique constraint or lock
- [ ] Optimistic upsert without conflict handling (`INSERT ... ON CONFLICT DO NOTHING` with no retry)
- [ ] Token or resource validity checked before use but not at the moment of use (TOCTOU)

Flags:
- Check-then-act on a DB record with no uniqueness enforcement or lock — **blocker**
- Token validity checked only at entry, not at point of use after a long async chain — **major**

#### A3. Async/Await and Concurrency Primitives

- [ ] `Promise.all` used with an unbounded array of promises (can spawn thousands of concurrent operations)
- [ ] `for...of` with `await` inside where `Promise.all` would allow safe parallelism (sequential when parallel is intended)
- [ ] Missing concurrency limit: N parallel jobs where N = input size (use a concurrency limiter / semaphore for unbounded inputs)
- [ ] `async` function swallowing rejection via unhandled `.catch(() => {})` on a fire-and-forget

Flags:
- `Promise.all(items.map(...))` where `items` can be arbitrarily large — **major** (resource exhaustion)
- Fire-and-forget async call with no error handling and no queue backing — **major**
- Missing concurrency cap on parallel operations whose count scales with user input — **major**

---

### Part B: Resource Management

#### B1. Connection Pools

- [ ] Database / Redis / HTTP connection created per request instead of using a shared pool
- [ ] Connection pool size not configured — using default (often 5–10 connections), which will queue at scale
- [ ] Pool exhaustion handling: no timeout on `pool.connect()`, no error boundary — requests will hang silently
- [ ] Connection opened in a function that may throw before `.release()` or `.end()` without a `finally` block

Flags:
- `new Pool()` / `new Client()` / `createConnection()` inside a request handler — **blocker**
- No pool max size configured for a production service — **major**
- Connection acquired without guaranteed release in finally — **major**
- Pool timeout not configured (will queue indefinitely on exhaustion) — **minor**

#### B2. File Handles and Streams

- [ ] File opened with `fs.open` / `fs.createReadStream` without explicit close / destroy on error
- [ ] Readable stream not consumed (memory grows indefinitely until GC or crash)
- [ ] Large file read into memory at once (`fs.readFileSync` / `Buffer.concat` on unknown-size input) — use streams

Flags:
- File handle without guaranteed close — **major**
- `readFileSync` or full `Buffer.concat` on potentially large/user-supplied files — **major**
- Unhandled readable stream accumulating in memory — **major**

#### B3. Memory and Object Allocation

- [ ] Large objects allocated per-request that are not freed between requests
- [ ] In-process cache (plain `Map`) with no eviction policy — grows unboundedly
- [ ] Closure capturing a large object (e.g., full DB result set) in a long-lived data structure

Flags:
- In-process cache `Map` / `Record` with no TTL or max-size eviction — **major**
- Per-request object allocation in a hot path that could be pooled or reused — **minor**

---

### Part C: Caching

#### C1. Cache Invalidation

- [ ] Cache entry updated after a write but not invalidated for related keys (stale reads after update)
- [ ] Cache TTL set to 0 (effectively no caching) or missing on a frequently-read, rarely-written entity
- [ ] Cache key not namespaced — collision between tenants / environments
- [ ] Caching a response that contains per-user data without scoping the key to the user

Flags:
- Cached response containing user-specific data with no user-scoped key — **blocker** (data leak)
- Related cache entries not invalidated after a mutating operation — **major**
- Missing cache key namespace in a multi-tenant or multi-environment system — **major**
- TTL missing or set to a value that is clearly mismatched with data freshness requirements — **minor**

#### C2. Cache Stampede

- [ ] High-traffic key expires simultaneously for many callers — no lock-based or probabilistic early expiry to prevent stampede
- [ ] Thundering herd: cache miss triggers N concurrent DB reads for the same key with no deduplication (e.g., no mutex/semaphore on the first fetch)

Flags:
- Hot key (called >100 RPS) with no stampede protection — **major**
- Cache miss firing N simultaneous DB queries with no in-flight deduplication — **major**

#### C3. Cache Correctness

- [ ] Mutable value stored in cache by reference (not a deep copy) — mutation after storage corrupts the cache
- [ ] Cache key includes non-deterministic components (timestamp, random value, process ID)

Flags:
- Storing a mutable reference in cache (object not serialized/cloned) — **major**
- Non-deterministic cache key — **major**

---

### Part D: Database Access Under Load

#### D1. Missing Indexes

- [ ] Query filtering or ordering by a column not in an index on a large table
- [ ] JOIN on a column that lacks an index on at least one side
- [ ] Unique constraint missing on a column used in uniqueness checks

Flags:
- `WHERE` / `ORDER BY` on an un-indexed column on a high-traffic table — **major**
- Missing unique constraint where the application relies on uniqueness — **blocker**

#### D2. Lock Contention

- [ ] `SELECT ... FOR UPDATE` on a wide row range — locks more rows than needed
- [ ] Transaction holding a lock while performing external I/O (HTTP call, file read) — lock held far too long
- [ ] Nested transactions with locks — can deadlock under concurrent writers
- [ ] Long-running migration with a full-table lock on a live, high-traffic table

Flags:
- External I/O (HTTP, file) inside a database transaction — **blocker**
- `SELECT ... FOR UPDATE` with no LIMIT on a high-traffic table — **major**
- Schema migration adding NOT NULL column without a default on a live table — **major**

#### D3. N+1 and Unbounded Queries

- [ ] Query inside a loop where one batch query would suffice
- [ ] `findAll()` / `SELECT *` on a large table with no LIMIT/pagination
- [ ] Fetching full entity to check a single field

Flags:
- N+1 in a hot path — **major** (also flagged by `review-performance`, noted here for load context)
- Unbounded `findAll()` on a table that grows with usage — **major**
- Fetching full row just to read one column — **minor**

#### D4. Connection and Transaction Hygiene

- [ ] Transaction started but no explicit commit / rollback on all code paths (leak on exception)
- [ ] Long-lived transaction (spans multiple user interactions or HTTP calls)
- [ ] Mixing read replicas and write primary within the same business operation without awareness of replication lag

Flags:
- Transaction with no guaranteed commit/rollback on exception path — **major**
- Replication lag not accounted for (read-your-writes guarantee assumed on replica) — **major**

---

### Part E: Async Processing and Queues

#### E1. Queue Backpressure

- [ ] Producer adding to an in-memory queue with no max depth — under load the queue grows until OOM
- [ ] Consumer not acknowledging/nacking messages — messages redeliver indefinitely on crash
- [ ] Batch consumer with no upper bound on batch size — single batch can take arbitrarily long

Flags:
- Unbounded in-memory queue / channel — **blocker**
- Message consumer missing ack/nack — **major**
- Batch size not capped — **major**

#### E2. Dead Letter and Poison Pills

- [ ] No dead-letter queue for failed messages — poison pills block the consumer indefinitely
- [ ] Retry loop with no maximum retry count — failed message retried forever
- [ ] Consumer crashing on a single malformed message due to missing error handling around deserialization

Flags:
- No DLQ or max retry limit on a message consumer — **major**
- Deserialization error crashing the consumer process — **major**

#### E3. Ordering Guarantees

- [ ] Code assumes FIFO delivery on a queue that does not guarantee ordering (e.g., SQS standard)
- [ ] Parallel consumers writing to shared state where order matters

Flags:
- FIFO assumption on an at-least-once / unordered queue — **major**

---

### Part F: Retry, Timeout, and Circuit Breaker

#### F1. Retry Safety

- [ ] Non-idempotent operation retried without idempotency key (charge, send email, create record)
- [ ] Retry with fixed delay instead of exponential backoff — causes retry storms
- [ ] No maximum retry count — code retries indefinitely
- [ ] Missing jitter on exponential backoff — synchronized retries cause thundering herd

Flags:
- Non-idempotent write retried without idempotency key — **blocker** (data integrity)
- Fixed delay retry or no backoff — **major**
- No max retry count — **major**
- Exponential backoff without jitter — **minor**

#### F2. Timeouts

- [ ] HTTP client / DB call / queue operation with no timeout configured
- [ ] Single timeout for the full chain (outer timeout too long relative to the number of downstream calls)
- [ ] `setTimeout` as a timeout substitute for async operations that do not stop when the timer fires

Flags:
- External call with no timeout — **major**
- Using `setTimeout` as a "give up" timer without actually canceling the operation — **minor**

#### F3. Circuit Breaker

- [ ] Repeated calls to a known-failing downstream without a circuit breaker — floods the downstream and starves the thread pool
- [ ] Fallback returning stale/empty data not documented as intentional degradation

Flags:
- Unbounded retries to a failing downstream without circuit breaker — **major**
- No fallback or graceful degradation when downstream is unavailable — **minor**

---

### Part G: Idempotency and Distributed Invariants

#### G1. Idempotency

- [ ] Webhook / event handler has no deduplication — processing the same event twice produces duplicate side effects
- [ ] API endpoint that creates a resource not accepting or generating an idempotency key
- [ ] Distributed cron/scheduled job running on multiple instances simultaneously with no distributed lock

Flags:
- Event handler with no deduplication and non-idempotent side effects — **blocker**
- Distributed cron with no leader election or distributed lock — **blocker**
- Resource creation endpoint with no idempotency key support — **major**

#### G2. Distributed Consistency

- [ ] Assumption that two sequential operations form an atomic unit without a transaction or saga
- [ ] Cross-service write sequence with no compensation logic on partial failure
- [ ] Relying on eventual consistency while assuming immediate consistency (reading from cache/replica right after writing)

Flags:
- Multi-step cross-service operation with no rollback / saga — **major**
- Assumed immediate consistency where eventual consistency is the actual guarantee — **major**

#### G3. Clock and ID Assumptions

- [ ] Using `Date.now()` or `new Date()` for ordering events across distributed nodes — clocks drift
- [ ] Auto-increment integer IDs expected to be globally unique across sharded databases
- [ ] UUID v1 (time-based, exposable MAC address) used where UUID v4 (random) is safer

Flags:
- Event ordering based on wall-clock time in a distributed context — **major**
- Assumption of globally unique sequential IDs across shards — **major**

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Race conditions, shared mutable state, concurrent writes | YES | — |
| Connection pool exhaustion, resource leaks | YES | — |
| Cache invalidation, cache stampede, stale reads | YES | — |
| Lock contention, long transactions, missing indexes | YES | — |
| Queue backpressure, dead letters, ordering | YES | — |
| Retry storms, timeouts, circuit breakers | YES | — |
| Idempotency, distributed locks, distributed consistency | YES | — |
| Frontend re-render performance, bundle size | NO | `review-performance` |
| General N+1 queries (not load-specific) | NO | `review-performance` |
| NestJS module structure, layer violations | NO | `review-architecture` |
| Memory leaks in React components | NO | `review-performance` |
| Logic bugs unrelated to concurrency | NO | `review-logic` |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Pattern**: Concurrency A1 — Shared Mutable State | Resource B1 — Connection Pool | etc.
- **Failure mode**: what specifically breaks under load and at what scale
- **Fix**: concrete change with reference pattern (exponential backoff, connection pool, distributed lock, etc.)
- **Patch** (optional): unified diff
```

The **Failure mode** line is mandatory for this reviewer — every finding must state the load-related consequence (OOM at 1k RPS, connection exhaustion at 500 concurrent users, duplicate charges on retry, etc.).

Severity guide:

| Severity | When to use |
|----------|------------|
| `blocker` | Race condition on shared state; non-idempotent retry; unbounded in-memory queue; distributed cron with no lock; transaction holding external I/O lock |
| `major` | Connection without pool; unbounded `Promise.all`; missing retry timeout/backoff; cache stampede on hot key; N+1 in hot path; long transaction; DLQ missing |
| `minor` | Backoff without jitter; TTL misconfigured; per-request allocation in hot path; full-row fetch for one field |
| `info` | Architectural note without concrete failure mode at current load |

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

```markdown
## High-Load Review

### Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Load profile: `<from context doc or "not provided">`
- Changed files reviewed: <N>

### Summary
<2-3 sentences: what changed, key high-load concerns, overall verdict at scale.>

### Stats
- blocker: N  |  major: N  |  minor: N  |  info: N

### Findings

#### Concurrency & Race Conditions
<[F-NNN] findings or "None detected.">

#### Resource Management
<[F-NNN] findings or "None detected.">

#### Caching
<[F-NNN] findings or "None detected.">

#### Database Under Load
<[F-NNN] findings or "None detected.">

#### Async / Queues
<[F-NNN] findings or "None detected.">

#### Retry / Timeout / Circuit Breaker
<[F-NNN] findings or "None detected.">

#### Idempotency & Distributed Invariants
<[F-NNN] findings or "None detected.">

### Clean Areas
[List checklist sections with no findings, confirming they were reviewed]
```

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before reviewing. Use it to:
- Understand the expected traffic profile (RPS, concurrent users, burst patterns)
- Know the infrastructure constraints (pool sizes, queue limits, replica topology)
- Identify intentional trade-offs already accepted (eventual consistency, at-least-once delivery)
- Avoid flagging documented acceptable degradation paths as violations

If absent, proceed normally — context is optional and non-blocking.
When load profile is unknown, note in findings that severity assumes "moderate-to-high traffic".

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "We don't have high traffic yet, so this is fine" | Correctness under concurrency does not depend on current traffic; a race condition exists at 1 RPS too |
| "The connection pool defaults are probably fine" | Default pools (5–10 connections) queue at a few hundred concurrent users; always verify |
| "Retrying this is safe because it's idempotent" | Verify it actually is — most `POST` endpoints are not idempotent by default |
| "We'll add a circuit breaker later" | "Later" is when the downstream is down; flag as minor now to create the record |
| "The cache invalidation is handled somewhere else" | "Somewhere else" means it will be missed — flag where the write happens with no corresponding invalidation |
| "This runs in a queue so race conditions don't apply" | Multiple consumer instances still race on shared DB rows unless explicitly serialized |
| "Using Date.now() for ordering is fine" | Clock skew across nodes makes wall-clock ordering unreliable; use logical clocks or DB sequences |

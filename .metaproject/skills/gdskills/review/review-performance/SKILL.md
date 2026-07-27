---
name: review-performance
description: "Use when a performance review is requested, checking for N+1 queries, unnecessary re-renders, memory leaks, missing indexes, large bundle imports, and synchronous blocking in changed code. NOT for security, logic correctness, style, or architecture."
triggers:
  - "review performance"
  - "performance review"
  - "check for perf issues"
  - "perf review"
  - "check N+1"
  - dispatched by review-orchestrator
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review: Performance (Code-Level Bottlenecks)

## Purpose

Finds real, code-level performance problems introduced in the changed code of the current branch. Covers N+1 database queries, unnecessary React re-renders, missing memoization in hot paths, memory leaks, large bundle imports, synchronous blocking in async contexts, missing pagination, and redundant API calls.

This skill focuses on **measurable or high-likelihood bottlenecks** only. Premature optimization, hypothetical slowness, and style preferences are out of scope.

---

## Input Contract

| Field | Required | Description |
|-------|----------|-------------|
| Branch / diff range | No | Defaults to merge-base..HEAD + uncommitted changes |
| Explicit commit hash/range | No | Review only that range when provided |
| `JOB_NAME` | No | Job name when dispatched by orchestrator |
| `CONTEXT_PATH` | No | Path to context doc when dispatched by orchestrator |

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| N+1 database queries, missing eager loading | YES | — |
| Unnecessary React re-renders, missing memo/useCallback/useMemo | YES | — |
| Expensive computations in hot paths (render loops, tight loops) | YES | — |
| Missing database indexes (detectable from query patterns) | YES | — |
| Memory leaks: unbounded collections, missing cleanup, forgotten subscriptions | YES | — |
| Large bundle imports vs. named imports | YES | — |
| Synchronous blocking in async contexts | YES | — |
| Missing pagination on large datasets | YES | — |
| Redundant API calls (same data fetched multiple times) | YES | — |
| MobX: manual derived state in renders instead of @computed | YES | — |
| Security vulnerabilities | NO | `review-security-code` |
| Logic correctness, race conditions | NO | `review-logic` |
| Architecture decisions | NO | `review-architecture` |
| Code style, naming | NO | `code-style-review` |
| npm/bun dependency vulnerabilities, bundle analysis tooling | NO | `security-audit` / `perf-check` |

---

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script from that file to determine `MERGE_BASE` (`BASE_SHA`) and `SCOPE` before proceeding.

### Commands to collect the review slice

```bash
git status
git log --oneline "${BASE_SHA}..HEAD"
git diff --stat --name-status "${BASE_SHA}..HEAD"
git diff "${BASE_SHA}..HEAD"

# Include uncommitted changes (default mode):
git diff --stat --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

For explicit hash/range mode:

```bash
git diff --stat --name-status <FROM_SHA>..<TO_SHA>
git diff <FROM_SHA>..<TO_SHA>
```

---

## Review Checklist

Work through every category below for each changed file. Tie every finding to a concrete line in the diff. For each finding, state **the hot path or execution frequency** that makes it a real problem — without that, it is INFO only.

### 1. N+1 Database Queries

**Detection patterns:**
- [ ] Loop or `.map()` containing a DB query, repository call, or Prisma/TypeORM find
- [ ] `for (const item of items) { await repo.findOne(...) }` — classic N+1
- [ ] ORM relation accessed without eager loading inside iteration: `order.items` where `items` is a lazy relation loaded inside a loop
- [ ] GraphQL resolver loading a child relation per parent without a DataLoader

**Correct patterns to confirm:**
- Prisma: `include` / `select` on the parent query to fetch relations in one round trip
- TypeORM: `createQueryBuilder().leftJoinAndSelect()` or `findOptions.relations`
- MikroORM: `populate` option
- Raw SQL: `JOIN` rather than a secondary query per row

**Hot path requirement:** State whether this runs per HTTP request, per list item render, per job iteration, etc.

### 2. Unnecessary React Re-renders

**Detection patterns:**
- [ ] Object or array literal created inline in JSX: `<Component options={{ key: val }} />` — new reference every render
- [ ] Arrow function created inline as prop: `<Button onClick={() => store.doX()} />` — new reference every render
- [ ] Large expensive computation performed directly in render body (not in useMemo)
- [ ] Context value object created inline without useMemo: `<MyContext.Provider value={{ a, b }}>` — every parent render triggers all consumers
- [ ] Component receiving a new object/array reference from props despite same data (parent not memoizing)

**When memo IS justified (flag absence):**
- [ ] Pure child component receiving stable props but not wrapped in `React.memo` — only flag if the parent re-renders frequently (e.g., on keypress, scroll, animation frame)
- [ ] `useCallback` absent for a callback passed to a `React.memo` child — only flag if the child is expensive

**MobX note:** With MobX + observer, `useCallback`/`useMemo` are rarely needed. Do NOT flag their absence unless there is concrete evidence of re-render cost. Flag only missing `observer()` (see `review-frontend` for full MobX checklist).

### 3. Expensive Computations in Hot Paths

- [ ] Sorting, filtering, or reducing a large array inside a render function without `useMemo`
- [ ] Deep clone (`JSON.parse(JSON.stringify(...))`) inside a loop or on every render
- [ ] Regex compilation inside a loop — should be compiled once outside: `const RE = /pattern/`
- [ ] `Object.keys().reduce()` or similar aggregation recalculated on every render instead of being derived in store or memoized
- [ ] Recursive computation without memoization called in a loop

**Hot path requirement:** An expensive computation is only a `major` finding if it runs at render time or in a tight loop. A one-time computation at load time is `info` at most.

### 4. Missing Database Indexes

Detectable from query patterns in changed code (not from DB schema directly):

- [ ] New query filtering on a column that is not a primary key and not obviously indexed: `WHERE email = ?` without a unique constraint visible in the schema or migration
- [ ] `ORDER BY created_at DESC` on a table with potentially large row counts — `created_at` index not evident
- [ ] `LIKE '%term%'` — prefix wildcard prevents index use; flag as info with suggestion to use full-text search
- [ ] Foreign key column used in JOIN without an index (common ORM footgun)

**Evidence requirement:** Cannot confirm an index is missing without seeing the migration or schema. If schema is not in the diff, downgrade to `minor` and note that the reviewer should check the schema.

### 5. Memory Leaks

**Event listeners and subscriptions:**
- [ ] `addEventListener` without matching `removeEventListener` in cleanup
- [ ] `setInterval` / `setTimeout` (recurring) without `clearInterval` / `clearTimeout` in cleanup
- [ ] RxJS `subscribe()` without `unsubscribe()` stored in a disposable or returned from useEffect cleanup
- [ ] MobX `autorun` / `reaction` / `when` without disposer called in `dispose()` (see `review-frontend` for full checklist)
- [ ] WebSocket or SSE connection opened without close in cleanup

**React useEffect:**
- [ ] `useEffect` that creates a subscription, timer, or async operation but returns no cleanup function

**Unbounded collections:**
- [ ] Map, Set, or array that grows on every event/request with no eviction, max size, or TTL
- [ ] Cache object that accumulates entries indefinitely: `const cache = {}; cache[key] = value`
- [ ] Growing error log array or history buffer without a max length

**Node.js / Server:**
- [ ] `EventEmitter` with `on()` inside a request handler — new listener per request, no removal
- [ ] `process.on('uncaughtException', ...)` registered multiple times (inside a function called per request)

### 6. Large Bundle Imports

- [ ] Default import of a large library when only one function is needed: `import _ from 'lodash'` instead of `import debounce from 'lodash/debounce'`
- [ ] `import * as Icons from '@mui/icons-material'` — imports entire icon tree
- [ ] `import { something } from 'date-fns'` — this is correct (tree-shakeable); flag `import dateFns from 'date-fns'`
- [ ] Side-effect imports pulling in large polyfills unnecessarily
- [ ] Dynamic `import()` inside a render function or tight loop (re-creates module promise)

**Evidence requirement:** Only flag if the library is known to be large (lodash, moment, antd, @mui). For unfamiliar libraries, flag as `info`.

### 7. Synchronous Blocking in Async Contexts

- [ ] `fs.readFileSync` / `fs.writeFileSync` inside a request handler or async function
- [ ] `child_process.execSync` in a Node.js server handler
- [ ] CPU-intensive synchronous computation (sorting large arrays, JSON.parse of large payloads) in an Express/NestJS handler without offloading to a worker
- [ ] `new Promise(resolve => setTimeout(resolve, N))` — artificial sleep in a server handler
- [ ] Synchronous DB client used in an async context (e.g., `better-sqlite3` in an Express handler serving concurrent requests)

### 8. Missing Pagination

- [ ] Repository query with no `take`/`limit` on a collection that could grow (user-generated content, logs, history)
- [ ] `findAll()` / `find({})` with no limit on a table mentioned as potentially large in context
- [ ] API endpoint returning an array without `page`/`cursor`/`limit` parameters when the underlying data is unbounded

**Evidence requirement:** Only flag as `major` if the dataset is described as large or clearly unbounded. For small controlled datasets, flag as `minor`.

### 9. Redundant API Calls

- [ ] Same endpoint fetched multiple times in the same render cycle or component tree without caching
- [ ] Two sibling components each fetching the same data independently instead of sharing state / lifting to parent store
- [ ] `useEffect` with a dependency array that triggers refetch on every render due to non-primitive dependency (object identity)
- [ ] Polling without deduplication when multiple component instances are mounted

### 10. MobX: Derived State Computed in Renders

- [ ] Value derived from observables computed inline in a component: `const total = store.items.reduce(...)` — should be `@computed get total()` in the store
- [ ] Filtered list recalculated in render: `store.items.filter(x => x.active)` — should be a `@computed`
- [ ] Conditional format derived from observable in render instead of a computed getter

---

## Iron Laws

1. **Only flag real performance issues, not premature optimization.** A pattern "that could be slow" without a concrete hot path or execution frequency is `info` only.
2. **Every `blocker` or `major` finding MUST cite the specific hot path or frequency that makes it a real problem.** "Runs on every keystroke", "called per list item (N=potentially thousands)", "executes on every render of a high-frequency parent" — be specific.
3. **"Might be slow" without evidence = INFO only, never blocker.** If you cannot articulate the execution frequency and expected data scale, do not escalate.
4. **Do not flag patterns outside the diff.** Review only changed code. Legacy issues outside the diff are `info` at most, with a note to track separately.

---

## Output Contract

### Status line (first line of response)

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — review complete, findings (if any) are below
- `DONE_WITH_CONCERNS` — one or more `blocker` or `major` findings found
- `NEEDS_CONTEXT` — cannot assess severity without additional context (e.g., expected dataset size, render frequency not determinable from diff alone)
- `BLOCKED` — cannot run git commands or access the repo

### Report structure

```markdown
STATUS: DONE_WITH_CONCERNS

## Performance Review

### Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: default-with-uncommitted | explicit-hash-range
- Changed files reviewed: <N>

### Summary
- Blockers: <N>
- Major: <N>
- Minor: <N>
- Info: <N>

### Findings

### [F-001] Title
- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Hot path**: where/how often this code executes (render, per-request, per-item in N-length loop, etc.)
- **Problem**: what is wrong in the code
- **Why it matters**: concrete impact (latency spike, memory growth, render thrash, etc.)
- **Fix**: concrete suggestion
- **Patch** (optional):
```diff
- slow line
+ optimized line
```

### Clean Areas
[List categories with no findings, confirming they were checked]
```

### Severity definitions

| Severity | Meaning |
|----------|---------|
| `blocker` | Demonstrable performance regression on a critical path; will noticeably degrade UX or server capacity under expected load |
| `major` | High-likelihood bottleneck on a frequently executed path; strongly recommended before merge |
| `minor` | Inefficiency worth fixing but not on a hot path; can ship, should be tracked |
| `info` | Pattern worth noting; no clear hot path or measurable impact in current code |

---

## Red Flags Table

Stop and re-read these rules if you are thinking:

| Rationalization | Why it's wrong |
|---|---|
| "This loop iterates over user data, so N+1 is obviously a problem" | State the expected N and query cost; "user data" is not self-evidently large |
| "I'll flag this as major because it looks slow" | Looking slow is not a hot path; cite the execution context |
| "Missing useMemo here is a performance issue" | useMemo has overhead; only flag when the computation is measurably expensive or the component re-renders at high frequency |
| "I'll add a minor finding for every lodash default import" | Correct — but only flag if the library is large and the import is demonstrably not tree-shaken |
| "The dataset could grow large, so I'll call it a blocker" | "Could grow" = minor or info; known to be large = major or blocker |
| "Skipping the hot-path citation to keep the finding concise" | Iron Law 2: hot path is mandatory for blocker/major; omitting it means downgrading to info |

---

## Job Context Awareness

When dispatched by `job-orchestrator` or `review-orchestrator` as part of a job pipeline, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before starting the review. Use it to:
- Understand expected dataset sizes and traffic patterns documented for the project
- Identify ORM and caching strategies already in place (avoid flagging already-cached paths)
- Understand which MobX patterns and React memo conventions the project follows
- Avoid flagging intentional trade-offs (e.g., a known small dataset where pagination is explicitly deferred)

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.


## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---


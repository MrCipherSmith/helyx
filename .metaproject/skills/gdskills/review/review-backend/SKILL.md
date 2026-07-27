---
name: review-backend
description: |
  Use when: reviewing NestJS backend changes — API design, service layer, DTO validation,
  database patterns, and TypeScript correctness. Covers "review backend", "backend review",
  "review API", "review NestJS", or dispatched by review-orchestrator with --backend flag.
  NOT for: frontend patterns, MobX, React components, general security vulnerabilities
  (use review-security-code for XSS/injection/auth-bypass), or performance profiling
  (use review-performance).
version: "1.0.0"
triggers:
  - "review backend"
  - "backend review"
  - "review API"
  - "review NestJS"
  - "review --backend"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review — Backend (NestJS / API / DB)

Focused backend reviewer covering NestJS patterns, REST API design, database access patterns,
and TypeScript correctness for service-layer code. This skill does NOT duplicate security or
performance checks — those belong to `review-security-code` and `review-performance`.

---

## Workflow

```
review-backend Progress:
- [ ] Step 1: Read Job Context (if CONTEXT_PATH provided)
- [ ] Step 2: Determine git scope (merge-base) — see skills/shared/git-merge-base.md
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: NestJS patterns check
- [ ] Step 5: API design check
- [ ] Step 6: Database patterns check
- [ ] Step 7: TypeScript correctness check
- [ ] Step 8: Emit findings in unified format, sorted by severity
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit range (e.g., `abc123..HEAD`). Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document (e.g., `<JOBS_ROOT>/<job>/ai/context.md`). |
| `issue_url` | string | no | GitHub issue or task URL for spec compliance reference. |

---

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run that script to determine `BASE_SHA` before collecting the diff.

```bash
# Default mode — all changes from merge-base to working tree
git diff --name-only "${BASE_SHA}"
git diff "${BASE_SHA}"

# Explicit range mode
git diff --name-only <FROM_SHA>..<TO_SHA>
git diff <FROM_SHA>..<TO_SHA>
```

Only review files changed in scope. Do not comment on legacy code outside the diff.

---

## Review Checklist

### 1. NestJS Patterns

**Module structure**
- `@Module()` declaration present; providers, imports, exports are correctly listed
- Circular dependency risk: two modules importing each other — flag as `major` if detected; suggest `forwardRef()`
- Feature modules do not import `AppModule`

**Provider scope**
- Default scope is `Singleton` — correct for stateless services
- `REQUEST`-scoped provider injected into a `Singleton` provider is a **blocker** (creates hidden state sharing)
- `TRANSIENT` scope used unnecessarily when singleton would suffice — flag as `minor`

**DTO validation**
- All controller methods accepting user input (body, query, param) have a DTO class decorated with `class-validator` decorators
- Required fields: `@IsString()`, `@IsNumber()`, `@IsEmail()`, etc. present and accurate
- `@IsOptional()` used only on truly optional fields; non-optional fields must not have `@IsOptional()`
- `ValidationPipe` applied globally (in `main.ts`) or explicitly via `@UsePipes(ValidationPipe)` — **blocker** if missing on any endpoint accepting user input
- `@Transform()` used where input coercion is needed (e.g., string → number from query params)

**Guards and roles**
- Protected endpoints have `@UseGuards(...)` with appropriate guard(s)
- Role-based access uses `@Roles(...)` decorator with a roles guard — missing guard on an endpoint that should be protected is a **blocker**
- Public endpoints explicitly marked with `@Public()` or equivalent decorator, not just left unguarded

**Controller responsibilities**
- Controllers are thin: no business logic, no direct ORM calls, no computation
- Controller methods do: parse input → delegate to service → return response
- If business logic is in a controller method, flag as `major` ("move to service layer")

**Service layer**
- Business logic lives in services
- Services do not directly call the ORM in complex multi-step ways — that belongs in a repository or query object
- Services do not import `Request`/`Response` from HTTP framework (except for streaming or special cases)
- Services declare return types on all public methods

---

### 2. API Design

**HTTP method conventions**
- `GET` requests carry no body (flag as `major` if present)
- `POST` used for resource creation
- `PUT` for full replacement, `PATCH` for partial update — mixed usage without clear reason flagged as `minor`
- `DELETE` on correct resource path

**Response shape consistency**
- All endpoints in a controller return the same envelope shape (e.g., `{ data, meta }`) — inconsistency (sometimes object, sometimes raw array) flagged as `major`
- HTTP status codes match semantics: `201` for create, `200` for read/update, `204` for no-content delete, `404` for not found, `422` for validation failure

**Pagination**
- List endpoints that could return unbounded datasets must have pagination (`limit`/`offset` or `cursor`)
- Missing pagination on a list endpoint flagged as `major` when no obvious bound exists

**Error handling**
- Async controller methods must have error handling: either `try/catch` or a global exception filter
- Unhandled promise rejections (async method without try/catch, no global filter) — **blocker**
- Exception messages must not leak internal details (stack traces, ORM error strings) to the HTTP response — leaking is a **blocker**
- NestJS built-in exceptions (`NotFoundException`, `BadRequestException`, etc.) preferred over generic `Error`

---

### 3. Database Patterns (ORM)

**N+1 queries**
- Relation loaded inside a loop without eager loading (`relations`, `leftJoinAndSelect`) or a DataLoader — **always major**
- Example: `for (const user of users) { user.orders = await orderRepo.find(...) }` — flag with concrete suggestion to use `relations: ['orders']` or batch query

**Transactions**
- Multi-step operations that must be atomic (e.g., create + update + delete across tables) must use a transaction
- Missing transaction on a multi-step mutation is a **major** finding
- NestJS TypeORM: use `dataSource.transaction(async (manager) => { ... })` or `@Transaction()` decorator pattern

**Raw query safety**
- String interpolation in raw queries is a **blocker** (SQL injection risk)
- Use parameterized queries: `query('SELECT * FROM users WHERE id = $1', [id])`
- Flag `createQueryBuilder().where('id = ' + id)` as blocker

**Soft deletes**
- If the project schema uses `deletedAt` / `@DeleteDateColumn()`, deletions must use `.softRemove()` / `.softDelete()`, not `.remove()` / `.delete()`
- Hard delete on a soft-delete entity flagged as `major`

**Migration safety**
- Column removed in migration — check that no application code still references it
- Dropping a column without a deprecation period in a live system flagged as `major`
- `NOT NULL` column added without a default value to a populated table — **blocker**

---

### 4. TypeScript Correctness

- No `any` in new code — suggest `unknown` with type guards, or correct typed return
- Public service methods must have explicit return types (`Promise<UserDto>`, not inferred)
- Service contracts expressed as interfaces (`IUserService`), not just class implementations
- No `as any` or unsafe casts (`as unknown as T`) without a comment explaining why
- `@ts-ignore` / `@ts-expect-error` without explanation comment — flag as `minor`

---

## Iron Laws

| Condition | Severity |
|-----------|----------|
| Missing DTO validation on an endpoint accepting user input | **blocker** |
| `REQUEST`-scoped provider injected into `Singleton` | **blocker** |
| Leaking stack trace / raw ORM error to API response | **blocker** |
| Unhandled promise rejection in controller method | **blocker** |
| String interpolation in raw SQL query | **blocker** |
| N+1 query (relation loaded in a loop) | **major** (minimum) |
| Missing transaction on multi-step atomic mutation | **major** |
| Business logic in controller | **major** |
| Missing pagination on unbounded list endpoint | **major** |
| `NOT NULL` column added without default to populated table (migration) | **blocker** |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-001] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what is wrong
- **Why it matters**: impact on correctness / safety / maintainability
- **Fix**: concrete suggestion
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — no blockers or majors found
- `DONE_WITH_CONCERNS` — one or more blocker or major findings present
- `NEEDS_CONTEXT` — cannot determine intent without context doc or issue; state what is missing
- `BLOCKED` — cannot access diff or required files; state reason

```markdown
# Backend Review Report

## Verdict: APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES

## Summary
<2-4 sentences covering what changed, overall backend health, key concerns.>

## Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Changed files: <count>

## Stats
- blocker: N
- major: N
- minor: N
- info: N

## Blockers (must fix before merge)
<[F-NNN] findings>

## Major Issues
<[F-NNN] findings>

## Minor & Info
<[F-NNN] findings>

## Positive Notes
<Optional. Things done well.>
```

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| NestJS module / provider / DTO / controller / service | YES | — |
| REST API shape, HTTP methods, error handling | YES | — |
| Database ORM patterns, N+1, transactions, migrations | YES | — |
| TypeScript strictness in service layer | YES | — |
| XSS, injection (beyond SQL in raw queries), auth bypass | NO | `review-security-code` |
| Bundle size, query latency profiling | NO | `review-performance` |
| Frontend, React, MobX | NO | `review-frontend` |
| Architectural layer violations (cross-module) | NO | `review-architecture` |
| Naming, style, import order | NO | `review-style` |

---

## Job Context Awareness

When dispatched by `job-orchestrator` or called with an explicit context path, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** running scope detection.
Use it to understand:
- Which ORM, validation library, or guard strategy was intentionally chosen
- Project-level architectural decisions (e.g., no repository pattern by design)
- Acceptance criteria to verify spec compliance

If absent, proceed normally — context is optional and non-blocking.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "ValidationPipe is probably configured somewhere" | Always verify it is applied; assumption lets injection reach service layer |
| "The N+1 only runs on small datasets now" | Data grows; flag it now with a clear fix, not after the incident |
| "The controller has some logic but it's minor" | The line is binary — logic in controller = untestable without HTTP stack |
| "Stack trace in response only shows in dev" | Config can be wrong in prod; treat it as blocker always |
| "I'll skip the migration check — it's just a column rename" | Column renames without fallback break zero-downtime deploys |

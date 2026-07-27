---
name: review-architecture
description: |
  Use when: reviewing code for architectural violations — layer violations, dependency direction
  mistakes, module boundary coupling, SOLID principle breaches, NestJS module/provider structure,
  React MVVM boundary violations, or MobX store layer misplacement.
  Triggered by: "review architecture", "check architecture", "architectural review",
  or dispatched by review-orchestrator with --architecture or --backend.
  NOT for: style/naming preferences, logic correctness bugs, or security vulnerabilities.
version: "1.0.0"
triggers:
  - "review architecture"
  - "check architecture"
  - "architectural review"
  - "architecture review"
  - "check layers"
  - "dispatched by review-orchestrator"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review Architecture

Specialized reviewer for **architectural patterns and structural decisions**.
Reviews only changes introduced in the current branch (merge-base to HEAD).
Focuses exclusively on verifiable structural violations — not style opinions or hypothetical concerns.

---

## Workflow

```
Architecture Review Progress:
- [ ] Step 1: Read Job Context (if provided) — understand intentional stack choices
- [ ] Step 2: Determine git scope (merge-base)
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: Identify stack (NestJS, React+MobX, generic TS, mixed)
- [ ] Step 5: Check layer assignments and dependency direction
- [ ] Step 6: Check module/provider boundaries
- [ ] Step 7: Check design pattern correctness (Repository, DI, MVVM)
- [ ] Step 8: Check SOLID violations
- [ ] Step 9: Check framework-specific concerns (NestJS / React / MobX)
- [ ] Step 10: Emit findings in unified format
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit hash or range. Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document. Read before reviewing to understand intentional decisions. |
| `stack_hint` | string | no | Optional hint: `nestjs`, `react-mobx`, `generic-ts`. Reviewer auto-detects if absent. |

---

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script to determine `BASE_SHA`, then collect the diff:

```bash
# Changed files — used for stack auto-detection
git diff --name-status "${BASE_SHA}"

# Full diff — used for finding exact violations
git diff "${BASE_SHA}"

# Untracked new files
git ls-files --others --exclude-standard
```

Review scope: **changes introduced in the current branch since merge-base only**.
Do not review pre-existing architectural problems unless they are directly touched by the diff.

---

## Stack Auto-Detection

When `stack_hint` is not provided, infer from changed file paths:

| Signal | Detected stack |
|--------|---------------|
| `*.module.ts`, `*.controller.ts`, `*.provider.ts`, `@Injectable`, `@Module` | NestJS |
| `*.store.ts`, `makeObservable`, `observable`, `action`, `computed` (MobX) | React + MobX |
| `*.tsx` / `*.jsx` | React (check MVVM boundaries) |
| `prisma/`, `*.repository.ts`, `*.entity.ts` | Backend data layer |
| Mixed signals | fullstack — apply all relevant checks |

---

## Focus Areas and Checklist

### Layer Violations

A **layer violation** occurs when code belonging to one architectural layer is placed in another.
Common layers (adapt to the project's actual layering):

```
UI (View) → ViewModel / Store → Service → Domain → Infrastructure (DB, HTTP)
```

- [ ] API call or HTTP client import inside a React component (should be in store/service)
- [ ] Business logic inside a controller (should be in service/use-case)
- [ ] Database query directly inside a service bypassing the repository layer
- [ ] Domain entity mutating itself with HTTP response data (infrastructure leaking into domain)
- [ ] UI component computing derived state that belongs in a ViewModel or computed property

### Dependency Direction

Dependencies must flow **inward** (from infrastructure toward domain), never outward.

- [ ] Domain module importing from infrastructure (e.g., domain entity importing ORM types)
- [ ] Core/shared module importing from feature module (inverted dependency)
- [ ] Circular import between modules (A imports B, B imports A)
- [ ] Barrel file (`index.ts`) that creates hidden circular references

### Module Boundary Violations

- [ ] Feature A directly accessing feature B's internal service instead of a public API/facade
- [ ] Shared `utils/` or `common/` module containing domain-specific business logic
- [ ] Cross-module data transformation happening in the wrong module

### Design Pattern Misuse

**Repository pattern:**
- [ ] Repository method containing business logic (filtering/transformation beyond simple queries)
- [ ] Service bypassing repository and using ORM/DB client directly
- [ ] Multiple repositories doing the same data transformation independently

**Dependency Injection:**
- [ ] `new SomeService()` inside a class that should receive it via DI
- [ ] Service locator pattern used instead of constructor injection
- [ ] Singleton service holding request-scoped state

**CQRS / Use-case:**
- [ ] Command handler performing a query and returning domain data (mixed responsibility)
- [ ] Use-case importing another use-case (chain via domain events instead)

### SOLID Violations

Focus on **SRP** and **DIP** — the two most commonly violated in practice.

**SRP (Single Responsibility):**
- [ ] Class/module doing two unrelated things (e.g., handles auth AND sends emails)
- [ ] Service with >5 injected dependencies (smell: likely SRP violation)
- [ ] Component rendering UI AND fetching data AND computing derived state

**OCP (Open/Closed):**
- [ ] `switch`/`if-else` chain over a type discriminant that will grow (should be polymorphism or strategy)

**LSP (Liskov Substitution):**
- [ ] Subclass overriding a method with stronger preconditions or weaker postconditions

**ISP (Interface Segregation):**
- [ ] Implementing interface that forces implementing methods never used by this class

**DIP (Dependency Inversion):**
- [ ] High-level module importing a concrete low-level class (should import an abstraction)
- [ ] Infrastructure class passed directly through multiple layers instead of behind an interface

### NestJS-Specific

- [ ] `@Injectable` service used across modules without being exported from its owning module
- [ ] `@Global()` overused — global providers for non-truly-global concerns
- [ ] Circular dependency between NestJS modules without `forwardRef`
- [ ] Provider scope mismatch: `REQUEST`-scoped service injected into `DEFAULT`-scoped service
- [ ] Controller fat with business logic that belongs in the service layer
- [ ] `@Module` imports array including modules it does not need (unnecessary coupling)

### React + MVVM (with MobX)

- [ ] Business logic directly in a component (should be in store action or computed)
- [ ] `useEffect` performing state orchestration that belongs in a MobX reaction or action
- [ ] Store method calling another store's `private` action directly (should go through public API)
- [ ] Component subscribing to raw observable fields instead of using computed/derived values
- [ ] View rendering based on multiple raw observable fields instead of a single computed boolean

### MobX Store Layer

- [ ] `@action` performing async work without wrapping in `runInAction` on resolution
- [ ] `@computed` with side effects (computed must be pure)
- [ ] Observable state mutated outside of an `@action` (MobX strict mode violation)
- [ ] Store importing from another store's internal file instead of its public export
- [ ] Inter-store callback (`onChangeX`, `handleX`, `syncX`) declared `public` when only used internally (should be `private`)

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Layer violations, dependency direction, module coupling | YES | — |
| SOLID violations (SRP, DIP, OCP, LSP, ISP) | YES | — |
| NestJS module/provider/scope issues | YES | — |
| React MVVM boundary, MobX store layer | YES | — |
| Logic bugs, off-by-one, null safety | NO | `review-logic` |
| Security vulnerabilities (injection, auth bypass) | NO | `review-security-code` |
| Style, naming, import order | NO | `review-style` |
| Performance (bundle size, render cost, query plan) | NO | `review-performance` |
| MobX store internals deep-dive | surface violations only | `code-mobx-store-review` for full store audit |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what architectural rule is violated and how
- **Why it matters**: impact on testability / maintainability / correctness
- **Fix**: concrete structural change
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

Severity guide for this reviewer:

| Severity | When to use |
|----------|------------|
| `blocker` | Circular dependency causing runtime failure; NestJS module scope mismatch causing incorrect behavior; domain importing infrastructure breaking testability entirely |
| `major` | Clear layer violation (API call in component, business logic in controller); broken DIP; cross-module boundary coupling that will cause maintainability failures |
| `minor` | SRP smell with clear separation path; ISP violation; component using multiple raw observables instead of computed |
| `info` | Architectural opinion without clear violation; pattern that could be improved but works correctly |

Iron laws:
- Only flag actual violations found **in the diff**, not pre-existing issues untouched by the change.
- Every finding MUST cite a specific `file:line` from the diff.
- Architecture opinions without a clear, named violation (layer, SOLID principle, pattern misuse) are `info` only — never `blocker` or `major`.
- Do not flag correct framework usage as a violation just because an alternative exists.

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

| Status | Meaning |
|--------|---------|
| `DONE` | No blockers or majors found; architecture is sound in this diff |
| `DONE_WITH_CONCERNS` | One or more blocker or major findings present |
| `NEEDS_CONTEXT` | Cannot determine correct layering without knowing the project's architecture decisions |
| `BLOCKED` | Cannot access diff or required files |

```markdown
## Architecture Review

### Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Stack detected: <NestJS | React+MobX | generic-ts | fullstack>

### Summary
<2-3 sentences: what structural changes were introduced, overall architectural verdict.>

### Stats
- blocker: N  |  major: N  |  minor: N  |  info: N

### Layer Violations
<[F-NNN] findings or "None detected.">

### Dependency Direction
<[F-NNN] findings or "None detected.">

### Module Boundary Violations
<[F-NNN] findings or "None detected.">

### Design Pattern Misuse
<[F-NNN] findings or "None detected.">

### SOLID Violations
<[F-NNN] findings or "None detected.">

### Framework-Specific (NestJS / React+MobX)
<[F-NNN] findings or "None detected." or "N/A — not detected in stack.">

### Suggested Patches
<Minimal unified diffs for straightforward structural fixes. Omit if not warranted.>
```

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** reviewing the diff.
Use it to:
- Understand which architectural patterns and layers were intentionally chosen
- Avoid flagging deliberate deviations from the default layer model as violations
- Identify framework and library choices that affect what counts as a valid pattern

If absent, proceed normally — context is optional and non-blocking.
When in doubt about whether a pattern was intentional, use `info` severity and note the uncertainty.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "This class is large, so it must violate SRP" | Size alone is not a violation; cite what two unrelated responsibilities it holds |
| "I see a potential layer violation in a file not in the diff" | Scope is diff-only; pre-existing issues are out of scope unless the diff touches them |
| "This architecture opinion makes things cleaner, so it's a major" | Opinions without a named violation are `info` only |
| "I'll flag every cross-import as a boundary violation" | Not all cross-imports violate boundaries; check whether the dependency direction is correct |
| "The team probably didn't intend this pattern" | Unless the context doc or a clear rule says otherwise, assume intentional; use `info` if unsure |
| "NestJS global module is always wrong" | `@Global()` is a violation only when used for non-global concerns; framework-provided globals are fine |
| "I can't determine if this is wrong without knowing the full architecture" | Use `NEEDS_CONTEXT` status and ask one specific question |

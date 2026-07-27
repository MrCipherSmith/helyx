---
name: review-style
description: |
  Use when: reviewing code for style, naming conventions, readability, and DRY violations —
  without touching logic, architecture, security, or performance. Covers "review style",
  "style review", "check naming", "check readability", or dispatched by review-orchestrator
  with --style flag.
  NOT for: logic bugs, architectural violations, security vulnerabilities, performance
  anti-patterns, or any finding that could cause a functional regression.
version: "1.0.0"
triggers:
  - "review style"
  - "style review"
  - "check naming"
  - "check readability"
  - "review --style"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review — Style, Naming & Readability

Focused style reviewer. Covers naming conventions, dead code, readability, DRY violations,
import organization, comment quality, file length, cyclomatic complexity, and console noise.
Never touches logic correctness, architecture, security, or performance.

---

## Workflow

```
review-style Progress:
- [ ] Step 1: Read Job Context (if CONTEXT_PATH provided)
- [ ] Step 2: Determine git scope (merge-base) — see skills/shared/git-merge-base.md
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: Naming conventions check
- [ ] Step 5: Dead code and imports check
- [ ] Step 6: Readability and complexity check
- [ ] Step 7: DRY violations check
- [ ] Step 8: Comment quality check
- [ ] Step 9: File length and structure check
- [ ] Step 10: Console usage check
- [ ] Step 11: Emit findings in unified format, sorted by severity
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit range (e.g., `abc123..HEAD`). Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document (e.g., `<JOBS_ROOT>/<job>/ai/context.md`). |

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

Only review code changed in scope. Do not flag style issues in lines outside the diff.

---

## Review Checklist

### 1. Naming Conventions

**Variables and functions**
- `camelCase` for variables, function parameters, and function names
- `PascalCase` for classes, interfaces, enums, and React components
- `UPPER_SNAKE_CASE` for module-level constants (truly constant values, not `let` reassigned as constants)
- Boolean variables/functions prefixed with `is`, `has`, `can`, `should` (e.g., `isLoading`, `hasAccess`)
- Avoid single-letter names except in short array callbacks (`arr.map(x => x.id)` acceptable; `let x = fetchUser()` is not)
- Avoid abbreviations that are not universally understood (`usr`, `mgr`, `repo` vs `repository`)

**Functions**
- Function names are verbs or verb phrases: `getUser`, `handleSubmit`, `parseConfig`
- Event handlers prefixed with `on` or `handle`: `onSubmit`, `handleClick`
- Predicate functions return boolean and are named accordingly: `isValid()`, not `checkValid()`

**Classes and interfaces**
- Interface names use `I` prefix: `IUserService`, `IAuthGuard`
- Enum members: `UPPER_SNAKE_CASE` or `PascalCase` — whichever the project uses consistently; flag inconsistency
- Type alias names: `PascalCase`

**Files and directories**
- File names match the primary export: `UserService` → `user.service.ts`
- Test files: `*.spec.ts` or `*.test.ts` next to the subject file

Flag naming issues as `minor` unless the name is actively misleading (e.g., `isLoading` that is actually a count), which is `major`.

---

### 2. Dead Code and Unused Imports

- Unused variables (`const x = ...` never referenced) — flag as `minor`
- Unused function parameters in non-interface-implementing functions — flag as `minor`
- Unused imports — flag as `minor`; provide the removal patch
- Commented-out code blocks (more than one line) — flag as `minor`; ask: "Is this intentional? If not, remove."
- Exported functions/classes that are never imported anywhere in the diff scope — flag as `info`
  (may be used externally; do not assume dead without evidence)

---

### 3. Readability and Complexity

**Conditions**
- Overly complex boolean conditions (more than 3 clauses without parentheses grouping) — flag as `minor`; suggest extracting to a named predicate
- Double negatives (`!isNotEmpty`) — flag as `minor`; rewrite to positive form
- Ternary chains (ternary inside ternary) — flag as `minor`; suggest `if/else` or early return

**Nesting**
- Functions with callback nesting deeper than 3 levels — flag as `minor`; suggest extraction or `async/await`
- `if/else` trees deeper than 3 levels — flag as `minor`; suggest guard clauses (early returns)

**Magic numbers**
- Numeric or string literals used in logic without a named constant — flag as `minor`
- Exception: index `0`, `1`, `-1`, empty string `""`, and HTTP status codes when the context is obvious
- Suggest: `const MAX_RETRY_COUNT = 3;`

**Cyclomatic complexity**
- Functions with more than 10 decision branches (if/else/switch cases/ternary/loop) — flag as `minor`
- Suggest splitting into smaller, named functions

---

### 4. DRY Violations

- Clearly duplicated logic blocks (same or near-identical code in two places within the diff) — flag as `major` if the blocks are non-trivial (>5 lines), `minor` if small
- Duplicated string literals used in multiple places — flag as `info`; suggest a shared constant
- Similar switch/if-else trees that could be a lookup map — flag as `minor`

Do not flag DRY violations for code outside the diff even if legacy duplication exists.

---

### 5. Import Organization

- Imports must be grouped (framework/library imports first, then project imports, then relative imports); blank line between groups
- Imports within a group should be alphabetically sorted (or consistently ordered — match project convention)
- Barrel imports (`import * as X from '...'`) without reason — flag as `info`
- Circular imports (visible from import paths) — flag as `major`
- Re-exporting something that is immediately re-used in the same file — flag as `minor` (unnecessary indirection)

---

### 6. Comment Quality

**Misleading or outdated comments**
- Comment describes what the code does but the code has changed — flag as `minor`
- Comment says "TODO: remove before deploy" and was merged — flag as `major`
- Comment is actively wrong (incorrect description of behavior) — flag as `major`

**Missing JSDoc on public APIs**
- Public functions/classes exported from a module should have a JSDoc comment describing purpose, params, and return value
- Missing JSDoc on public APIs: flag as `info` (unless the project has a documented standard requiring it, in which case `minor`)

**Noise comments**
- `// increment i` above `i++` — flag as `info`; suggest removing
- Section divider comments (`// =========`) that add no semantic value — flag as `info`

---

### 7. File Length and Structure

- Files exceeding 500 lines (excluding generated code, test fixtures, and migration files) — flag as `info` with a suggestion to split by responsibility
- Files exceeding 800 lines — flag as `minor`
- Single file exporting more than 5 unrelated things — flag as `minor`; suggest splitting into focused modules
- Test files: no limit enforced; complexity handled by test count and grouping

---

### 8. Console Usage

- `console.log` / `console.error` / `console.warn` in non-test production code — flag as `minor`
- Suggest replacing with project logger (`AppLogger`, `Logger`, etc.) or remove entirely
- Exception: `console.error` in the outermost catch of a CLI entry point is acceptable

---

## Iron Laws

| Rule | Rationale |
|------|-----------|
| Style findings are **never** blockers unless they cause a functional bug | Style is a quality concern, not a safety gate |
| Maximum severity for pure style is `major` (only for actively misleading names or circular imports) | Most style is `minor` or `info` |
| Never flag issues handled by the project's autoformatter (indentation, trailing spaces, bracket style) | Linter/formatter owns that; double-flagging creates noise |
| Do not expand scope to architectural or logic concerns | Stay in style lane; hand off to the right reviewer |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-001] Title

- **Severity**: major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what is wrong
- **Why it matters**: readability / maintainability / DRY / convention consistency
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

- `DONE` — no major or above findings (minor/info only or none)
- `DONE_WITH_CONCERNS` — one or more major findings (actively misleading names, circular imports, non-trivial DRY violations)
- `NEEDS_CONTEXT` — project naming convention unclear and no context doc provided; state what is ambiguous
- `BLOCKED` — cannot access diff; state reason

```markdown
# Style Review Report

## Verdict: APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES

## Summary
<2-3 sentences: overall naming and readability health, notable patterns found.>

## Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Changed files: <count>

## Stats
- major: N
- minor: N
- info: N

## Major Issues
<[F-NNN] findings — misleading names, circular imports, significant DRY violations>

## Minor & Info
<[F-NNN] findings>

## Positive Notes
<Optional. Consistent naming, clean imports, good comments.>
```

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Naming, DRY, readability, imports, comments, file length | YES | — |
| Logic bugs, incorrect return values | NO | `review-logic` |
| Architectural layer violations | NO | `review-architecture` |
| Security vulnerabilities | NO | `review-security-code` |
| Performance anti-patterns | NO | `review-performance` |
| NestJS/backend patterns | NO | `review-backend` |
| React/MobX patterns | NO | `review-frontend` |

---

## Job Context Awareness

When dispatched by `job-orchestrator` or called with an explicit context path, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** running scope detection.
Use it to understand:
- Project-specific naming conventions (e.g., the project uses `PascalCase` for enums, not `UPPER_SNAKE_CASE`)
- Intentional style decisions documented as agreed-upon patterns (do not flag as issues)

If absent, infer conventions from surrounding unchanged code in the same files; note any ambiguity.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The naming is a bit odd but I understand it" | Reviewers understand their own code; the next dev won't |
| "Commented-out code might be needed later" | Git history exists for that; dead comments add noise |
| "It's only one magic number" | One `42` today becomes twelve untraceable `42`s tomorrow |
| "DRY violation is minor so I'll skip it" | Non-trivial duplication is `major`; do not understate it |
| "The file is 600 lines but it's organized" | Organization doesn't prevent merge conflicts and scroll fatigue |

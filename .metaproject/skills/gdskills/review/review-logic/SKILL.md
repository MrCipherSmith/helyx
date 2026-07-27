---
name: review-logic
description: |
  Use when: reviewing code for logic correctness, algorithmic bugs, missing error handling,
  async/await mistakes, null/undefined risks, race conditions, type contract violations,
  or spec compliance. Dispatched by review-orchestrator for --frontend, --backend, and --all.
  Also invoked directly: "review logic", "check correctness", "are there any bugs here".
  NOT for: security vulnerabilities, performance profiling, style/naming preferences,
  or architectural pattern concerns — those belong in their respective specialized reviewers.
version: "1.0.0"
triggers:
  - "review logic"
  - "check correctness"
  - "are there any bugs"
  - "check this for bugs"
  - "logic review"
  - "dispatched by review-orchestrator"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review Logic

Specialized reviewer for **logic correctness and algorithmic soundness**.
Inherits from the original `code-ai-review` + `code-boss-review` correctness phases
and unifies them into a single focused pass.

This reviewer does not care about formatting, naming, or architecture opinions.
Every finding must describe an observable, reproducible defect or a spec gap.

---

## Workflow

```
Logic Review Progress:
- [ ] Step 1: Read Job Context (if provided)
- [ ] Step 2: Determine git scope (merge-base)
- [ ] Step 3: Collect diff
- [ ] Step 4: Stage 1 — Spec compliance check (if issue/task provided)
- [ ] Step 5: Scan for logic bugs and type contract violations
- [ ] Step 6: Scan for async/race conditions and error handling gaps
- [ ] Step 7: Scan for null/undefined/optional chaining risks
- [ ] Step 8: Scan for edge cases and incorrect algorithm assumptions
- [ ] Step 9: Emit findings in unified format
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit hash or range. Overrides merge-base detection. |
| `issue_url` | string | no | GitHub issue or task URL. Required for Stage 1 spec compliance gate. |
| `context_doc` | string | no | Path to job context document. |

---

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script to determine `BASE_SHA`, then collect the diff:

```bash
# Committed + local changes (default mode)
git diff --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard

# Committed only (explicit range mode)
git diff --name-status <FROM>..<TO>
git diff <FROM>..<TO>
```

Review scope: **changes introduced in the current branch since merge-base only**.
Do not review unrelated files.

---

## Stage 1 — Spec Compliance (run first when issue/task is provided)

**ALWAYS check spec compliance before any quality pass.**

1. Fetch requirements from `issue_url` or `context_doc`.
2. For each acceptance criterion, verify it is addressed in the diff.
3. Emit an `[F-NNN]` finding with `severity: blocker` for every unimplemented criterion.
4. Record "spec gap" findings separately — they are always blockers.
5. Proceed to quality pass regardless of spec gaps found.

---

## Focus Areas and Checklist

### Logic Bugs

- [ ] Conditions evaluated in wrong order or with wrong operator (`&&`/`||` swap)
- [ ] Off-by-one errors in loops, slice indices, pagination
- [ ] Mutating data that should be immutable (unexpected aliasing)
- [ ] Wrong return value (returns before setting state, returns old value)
- [ ] Incorrect boolean logic (double negation, De Morgan's law violations)
- [ ] Unreachable branches or dead code that hides a bug

### Null / Undefined / Optional Chaining

- [ ] Accessing property on value that can be `null` or `undefined` without guard
- [ ] Optional chaining `?.` used where non-null is guaranteed (masking a real missing check)
- [ ] Non-null assertion `!` used without justification
- [ ] Array index access without bounds check
- [ ] `JSON.parse` without try/catch on untrusted input

### Async / Concurrency

- [ ] Missing `await` on async call — result is a `Promise`, not the value
- [ ] `await` inside a non-async function (syntax error or no-op)
- [ ] Parallel async calls that should be sequential (shared mutable state)
- [ ] Sequential `await` calls that could be `Promise.all` (performance is a secondary concern here; flag when correctness is affected by ordering assumption)
- [ ] Race conditions: state updated in one branch before a concurrent operation resolves
- [ ] Unhandled promise rejection (no `.catch`, no `try/catch`, no `Promise.allSettled`)
- [ ] `setTimeout`/`setInterval` with shared state and no cleanup

### Error Handling

- [ ] Swallowed `catch` blocks (catches error, does nothing)
- [ ] Error rethrown as generic string, losing stack trace
- [ ] Missing error boundary in UI component tree
- [ ] HTTP errors not checked (`response.ok` ignored)
- [ ] Partial success treated as full success (only first item processed, error on rest silently dropped)

### Type Contract Violations

- [ ] Function called with wrong argument type (widened or narrowed incorrectly)
- [ ] Return type of function does not match declared signature
- [ ] Type cast (`as X`) that hides a genuine mismatch
- [ ] Generic type parameter inferred as `unknown` or `any` silently
- [ ] Interface implementation missing required property

### Algorithm Assumptions

- [ ] Sort stability assumed but not guaranteed by runtime
- [ ] Hash map iteration order assumed to be insertion order
- [ ] Float equality comparison (`=== 0.1 + 0.2`)
- [ ] String comparison used for numeric ordering
- [ ] Regex without anchors applied to untrusted multi-line input

### Edge Cases

- [ ] Empty array / empty string not handled
- [ ] Single-element collection treated differently from multi-element
- [ ] Timezone / locale-sensitive date comparison without normalization
- [ ] Large number overflow (safe integer boundary)
- [ ] Concurrent execution with zero items (division by count)

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Logic bugs, type contracts, async errors, null safety | YES | — |
| Security vulnerabilities (injection, auth bypass, secrets) | NO | `review-security-code` |
| Performance profiling (bundle size, query cost, render cycles) | NO | `review-performance` |
| Style, naming, import organization | NO | `review-style` |
| Layer violations, SOLID, module coupling | NO | `review-architecture` |
| React/MobX-specific store patterns | NO | `code-mobx-store-review` |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what is wrong
- **Why it matters**: impact (data corruption / crash / silent wrong result / spec gap)
- **Fix**: concrete suggestion
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

Severity guide for this reviewer:

| Severity | When to use |
|----------|------------|
| `blocker` | Crash, data corruption, unimplemented acceptance criterion, unhandled promise rejection in critical path |
| `major` | Silent wrong result, race condition, swallowed error, type contract broken |
| `minor` | Edge case not handled but unlikely in practice, non-null assertion without comment |
| `info` | Suggestion to make code more defensive, no current observable defect |

Iron laws:
- Every `blocker` MUST include a concrete reproduction scenario or a spec reference.
- NEVER flag a style preference (naming, formatting) as a logic bug.
- If in doubt between `major` and `blocker`, use `major` — overstating severity loses credibility.

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

| Status | Meaning |
|--------|---------|
| `DONE` | No blockers or majors found; diff is logically sound |
| `DONE_WITH_CONCERNS` | One or more blocker or major findings present |
| `NEEDS_CONTEXT` | Spec or business logic is ambiguous; reviewer cannot determine correctness without clarification |
| `BLOCKED` | Cannot access diff or required files |

```markdown
## Logic Review

### Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Spec compliance gate: <ran | skipped — no issue/task provided>

### Summary
<2-3 sentences: what changed, overall correctness verdict.>

### Stats
- blocker: N  |  major: N  |  minor: N  |  info: N

### Spec Gaps (blocker)
<[F-NNN] findings for unimplemented acceptance criteria, or "None detected.">

### Logic Bugs
<[F-NNN] findings or "None detected.">

### Async & Concurrency
<[F-NNN] findings or "None detected.">

### Error Handling
<[F-NNN] findings or "None detected.">

### Null / Undefined Safety
<[F-NNN] findings or "None detected.">

### Type Contract Violations
<[F-NNN] findings or "None detected.">

### Edge Cases
<[F-NNN] findings or "None detected.">

### Suggested Patches
<Minimal unified diffs for straightforward fixes. Omit if no patch is warranted.>
```

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** the spec compliance gate.
Use it to:
- Understand intentional design decisions (do not flag correct library usage)
- Identify acceptance criteria if no `issue_url` is provided
- Calibrate severity for edge cases the team has explicitly accepted

If absent, proceed normally — context is optional and non-blocking.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "This style choice looks suspicious, so I'll flag it as a logic bug" | Style is not logic; keep concerns separated by domain |
| "I see a potential security issue" | Security belongs in `review-security-code`; note it as info and defer |
| "The spec is unclear so I'll skip the gate" | Unclear spec → `NEEDS_CONTEXT` status + ask for clarification |
| "I'll mark everything blocker to be safe" | Overstated severity makes reports unactionable; calibrate per the severity guide |
| "Async performance is slow, so that's a logic bug" | Performance lives in `review-performance` unless incorrect ordering changes the result |
| "I didn't reproduce the bug so I won't report it" | Every blocker needs a scenario, not a repro — describe the failing code path |

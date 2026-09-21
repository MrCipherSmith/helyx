---
name: review-logic
model_tier: standard
description: |
  Use when: reviewing code for logic correctness, algorithmic bugs, missing error handling,
  async/await mistakes, null/undefined risks, race conditions, type contract violations,
  or spec compliance. Dispatched by review-orchestrator for --frontend, --backend, and --all.
  Also invoked directly: "review logic", "check correctness", "are there any bugs here".
  NOT for: security vulnerabilities, performance profiling, style/naming preferences,
  or architectural pattern concerns — those belong in their respective specialized reviewers.
triggers:
  - "logic review"
  - "bug review"
  - "correctness"
  - "check correctness"
  - "are there any bugs"
  - "check this for bugs"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review Logic

Specialized reviewer for **logic correctness and algorithmic soundness**.
Inherits from the original `code-ai-review` + `code-learned-review` correctness phases
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

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

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

### The Change That Does Nothing

The diff adds a prop, guard, field or branch, and nothing can reach it. The code is
correct — which is why every reviewer asking "is this correct" passes it — and the
work the change was written to do is not done.

- [ ] A prop passed to a component that cannot act on it: the parent unmounts the
      child rather than disabling it, or the render site the prop guards is gated by
      a condition that is false whenever the prop is true.
- [ ] A field added to a type, a `Pick`, or a payload and never read. Search for the
      reads before accepting it as plumbing for a later change; if it is, say so.
- [ ] A guard against a value its producer cannot emit — `=== undefined` against a
      backend that stamps `0`, a status the producer writes in one place the route
      never reaches.
- [ ] State set on one path and cleared on none, or cleared only on paths the
      triggering interaction cannot take.
- [ ] A branch whose condition is unsatisfiable given the call sites in this repo.

Prove it by **negative enumeration**: name the complete candidate set and why each
member fails to apply, in `class_scope.enumeration_method` with `sites: []`. See
**Negative enumeration** in `review-orchestrator/SKILL.md` → Finding Format.

`minor` when the change is merely dead. `major` when its deadness means the defect
it was written to fix is still live — the usual case when the change answers an
earlier review round, because there the finding is recorded as closed and is not.

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

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

A finding anchored to one `file:line` is a claim about one site. The recorded
history of this repository is that a fix then repairs that site and leaves its
siblings: one writer of five, one operator instruction of four, six readers of
eight. Each was found by the *next* review round, which is why reviews here have
run to seven and four rounds instead of one.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it: enumerating the class for every low-severity
observation is theatre, not rigour.

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

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no table of its own; what follows is where its recurring
conditions land under that rubric, not a second rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| Unhandled promise rejection reaching the process | `blocker` | Crash |
| Corrupted or lost persisted/returned data | `blocker` | Data loss or corruption |
| Unimplemented acceptance criterion | `blocker` | Named shape 4 |
| Race condition on shared mutable state | `blocker` **if** the interleaving can corrupt or lose data; otherwise `major` | The outcome decides, not the word "race" |
| Silent wrong result on a named input | `major` | Trigger and outcome are both named |
| Swallowed error that hides a failed operation | `major` — `blocker` only if the caller then persists or returns wrong data | Silent failure is wrong behaviour; corruption is a different shape |
| Type contract broken (declared type is not what is returned) | `major` | Callers observe the wrong value |
| Edge case not handled, no input that reaches it named | `minor` | No trigger; the cost is to the next editor |
| Non-null assertion without a comment | `minor` | Behaves correctly today; the cost is to the reader |
| "Could be more defensive", no observable defect | `info` | Neither trigger nor maintenance cost named |

## Iron Laws

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot
   name the input, call, or condition that reaches the code, you have an
   observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code
   under review. Do not report a safe API because it could be misused, or a
   pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears
   at several sites, report it once and list every site. Ten findings that are one
   finding hide the other nine problems.

Severity levels are defined once, in `review-orchestrator/SKILL.md` →
**Severity (canonical)**. This reviewer does not restate them: `blocker` is the
four merge-blocking shapes named there and nothing else, and the `major`/`minor`
boundary is the trigger-and-outcome test.

### Logic laws

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

---
name: review-strict
description: |
  Use when: a strict engineering pass is needed — either as a meta-reviewer reading consolidated
  findings from other reviewers and elevating weak findings, or standalone on a git diff.
  Covers "strict review", "review --strict", "boss review", "review as boss", or dispatched
  by review-orchestrator as an optional post-pass after other reviewers complete.
  NOT for: first-pass review (run domain reviewers first); large refactors outside the diff
  scope (file separately).
version: "1.0.0"
triggers:
  - "strict review"
  - "review --strict"
  - "boss review"
  - "review as boss"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review — Strict (Meta-Reviewer)

Strict engineering review pass. This is a **meta-reviewer**: it reads findings from other
reviewers (or the raw diff when run standalone) and applies strict engineering judgment.
It elevates understated findings, adds architectural commentary, and catches issues that
domain reviewers may have let through. Style: direct, no-fluff, engineering-focused.

---

## Workflow

```
review-strict Progress:
- [ ] Step 1: Read Job Context (if CONTEXT_PATH provided)
- [ ] Step 2: Determine input mode (meta or standalone)
- [ ] Step 3: If standalone — determine git scope and collect diff
- [ ] Step 4: If meta — ingest findings from other reviewers
- [ ] Step 5: Apply strict principles to findings or diff
- [ ] Step 6: Elevate understated findings
- [ ] Step 7: Add new findings not caught by other reviewers
- [ ] Step 8: Check single source of truth violations
- [ ] Step 9: Emit enhanced findings + strict commentary
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `findings` | string | no | Consolidated findings from other reviewers (markdown). When present, operate in meta mode. |
| `branch` | string | no | Branch to review. Defaults to current branch. Required in standalone mode. |
| `commit_range` | string | no | Explicit range (e.g., `abc123..HEAD`). Overrides merge-base in standalone mode. |
| `context_doc` | string | no | Path to job context document (e.g., `<JOBS_ROOT>/<job>/ai/context.md`). |

---

## Mode Detection

**Meta mode** (preferred when dispatched by review-orchestrator `--strict`):
- Input includes pre-existing findings from domain reviewers
- Read those findings, then read the diff for context
- Operate on both: elevate weak findings, add new ones

**Standalone mode** (when invoked directly without pre-existing findings):
- No findings provided
- Determine git scope via `skills/shared/git-merge-base.md`
- Collect diff and apply full strict checklist independently

---

## Scope Detection (standalone mode)

See shared script: `skills/shared/git-merge-base.md`

```bash
# Default mode — all changes from merge-base to working tree
git diff --name-only "${BASE_SHA}"
git diff "${BASE_SHA}"

# Explicit range mode
git diff --name-only <FROM_SHA>..<TO_SHA>
git diff <FROM_SHA>..<TO_SHA>
```

---

## Strict Principles

### Elevation Rules (meta mode)

When reading findings from other reviewers, elevate severity when:

| Condition | Elevate to |
|-----------|-----------|
| Finding labeled `minor` but could cause a bug under specific conditions | `major` |
| Finding labeled `major` but blocks correctness or data integrity in any realistic scenario | `blocker` |
| Finding labeled `info` but represents a design flaw (not just a suggestion) | `minor` or `major` |
| Finding is vague ("consider refactoring X") without a concrete fix | Downgrade to `info` or rewrite with concrete fix |

Every elevation must cite the line or code evidence that justifies the change. No elevation without evidence.

---

### Core Strict Checks

**No ducktape fixes**
- A fix that masks a symptom rather than addressing the root cause — flag as `major`
- Example: `setTimeout(fn, 0)` to defer a race condition instead of fixing the race — flag as `major`; demand root cause fix
- Example: `|| []` to avoid a null check instead of ensuring the upstream always returns an array — flag as `minor` if trivial, `major` if the null case indicates a real upstream bug

**No magic timeouts**
- `setTimeout(fn, 0)`, `setTimeout(fn, 100)`, `setTimeout(fn, 500)` without a comment explaining exactly why — always flag as `major`
- Comment must explain: what is being deferred, why, and what the correct fix would be if time allowed
- `setInterval` without a cleanup mechanism — `major`

**No `any` and no unsafe casts**
- `any` in new code — `major`
- `as any` — `major`
- `as unknown as T` without an explanatory comment — `major`
- `@ts-ignore` without an explanatory comment — `major`

**TODO comments in merged code**
- `// TODO` / `// FIXME` / `// HACK` present in the diff — flag as `minor` with a note: "file a ticket or resolve before merge"
- `// TODO: remove before deploy` in production-bound code — **blocker**

**No architectural shortcuts**
- Logic in the wrong layer: UI layer calling APIs directly, controller containing business rules, view accessing store internals — `major`
- Challenge with: "why is this in this layer?" — must have a concrete answer
- Cross-cutting concerns scattered in multiple places instead of one — `major` (single source of truth violation)

**Single source of truth**
- Same rule or check duplicated in two or more places — flag as `major`
- Example: input validation logic in both the controller and the service — pick one authoritative location
- Example: same constant defined in two files — centralize

**MobX conventions (when MobX is in the diff)**
- Inter-store callbacks (`onChangeX`, `handleX`, `syncX`, `onFireX`) that are `public` — flag as `major` ("should be `private`; public only if called from JSX")
- `useCallback` or `useMemo` added without a demonstrable need (no expensive computation, no stable reference requirement) — flag as `minor`
- MobX `autorun` or `reaction` without a disposal mechanism — flag as `major` (memory leak)

**Conventions**
- `currentState` naming: observable state fields named with `current` prefix when they represent present value — flag inconsistency as `minor`
- Interface names without `I` prefix (`UserService` as an interface instead of `IUserService`) — flag as `minor`

**No scope expansion**
- Large refactors outside the diff scope: note them as `info` with "out of scope — file separately"
- Never propose a rewrite of unrelated code in the same response

---

## Architectural Commentary

After findings, add a brief "Not Today" section for:
- Architectural shortcuts visible in the diff that are not bugs but will hurt maintainability
- Technical debt introduced intentionally or unintentionally
- Patterns that contradict the project's stated architecture

Use the phrase "not today" sparingly — only when a shortcut was taken that needs to be acknowledged.
Format: `> **Not today:** [what was shortcutted and why it matters long-term]`

This section is non-blocking (info-level). It is opinion, not a finding. Keep it to ≤3 items.

---

## Iron Laws

| Rule | Rationale |
|------|-----------|
| Every finding must cite code evidence (file:line or diff hunk) | "Strictly speaking" without evidence = `info` only |
| No elevation without a concrete reason stated | Elevation is a claim; claims need backing |
| No scope expansion — large refactors outside the diff = "out of scope, file separately" | Scope creep in reviews is as harmful as in implementation |
| Severity of a finding is per-finding, never averaged or influenced by other findings | Each finding stands on its own |
| `setTimeout(0)` — always flag, no exceptions | There is always a better solution |
| `any` in new code — always flag, no exceptions | Type safety is non-negotiable |

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
- **Why it matters**: correctness / testability / conventions / maintainability
- **Fix**: concrete suggestion
- **Elevated from**: minor → major (or: new finding) <!-- only in meta mode -->
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

- `DONE` — no blockers or majors after strict pass
- `DONE_WITH_CONCERNS` — one or more blocker or major findings
- `NEEDS_CONTEXT` — cannot assess intent without context doc; state what is missing
- `BLOCKED` — cannot access diff or findings input; state reason

```markdown
# Strict Review Report

## Verdict: APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES

## Summary
<2-4 sentences: overall engineering quality, key concerns, whether findings from other
reviewers were understated.>

## Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Mode: `<meta | standalone>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Input findings ingested: <N> (meta mode only)

## Stats
- blocker: N (N elevated)
- major: N (N elevated, N new)
- minor: N
- info: N

## Blockers (must fix before merge)
<[F-NNN] findings>

## Major Issues
<[F-NNN] findings — mark elevated ones clearly>

## Minor & Info
<[F-NNN] findings>

## Not Today
> **Not today:** [architectural shortcut 1]
> **Not today:** [architectural shortcut 2]

## Positive Notes
<Optional. What held up to strict scrutiny.>
```

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Elevating/validating findings from domain reviewers | YES | — |
| Strict engineering commentary on diff | YES | — |
| `setTimeout`, `any`, ducktape, SSOT violations | YES | — |
| MobX conventions (inter-store access, disposal) | YES | — |
| First-pass logic review | NO | `review-logic` |
| First-pass frontend patterns | NO | `review-frontend` |
| First-pass backend patterns | NO | `review-backend` |
| Large out-of-scope refactors | NO | file separately |

---

## Job Context Awareness

When dispatched by `job-orchestrator` or called with an explicit context path, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** applying strict principles.
Use it to understand:
- Intentional architectural decisions (do not flag agreed-upon patterns as shortcuts)
- Which libraries, patterns, and conventions were explicitly chosen
- Acceptance criteria (to detect spec gaps if running standalone)

If absent, proceed normally — context is optional and non-blocking.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The other reviewer already caught it, I don't need to address it" | Meta mode means you own the final assessment; weak findings stay weak unless you act |
| "setTimeout(0) is a common pattern" | Common patterns can still be wrong; demand the root cause fix |
| "I'll add a 'Not Today' for everything I disagree with" | Not Today is for real shortcuts, not personal preference; ≤3 items |
| "Elevating to blocker feels harsh" | Harsh is blocking a production incident; elevate when the evidence supports it |
| "The `any` is in a test file" | Type safety in tests matters; typed mocks prevent false-green tests |

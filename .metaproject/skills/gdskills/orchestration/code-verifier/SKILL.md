---
name: code-verifier
model_tier: light
description: "Use when running a full quality gate after implementation — lint, type-check, tests, and import validation. Mandatory step in job-orchestrator after task-implementer and after fix iterations. Use standalone when you need a structured verification report. NOT for: fixing what the gate reports — this skill is read-only (use task-implementer)."
triggers:
  - "verify code"
  - "run checks"
  - "quality gate"
  - "Run verification"
  - "Check code quality"
  - "Run lint and tests"
  - "Verify implementation"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "orchestration"
  agent_worthy: true
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Code Verifier

## Purpose

Runs the full quality gate for a project: lint, type-check, tests, and import validation. Provides a structured, parseable result that the orchestrator uses to decide whether to proceed or trigger a fix loop.

**Distinct from `task-implementer` Phase 5:** task-implementer does inline self-verification during implementation. `code-verifier` is an independent gate that runs after all tasks in a wave are complete — giving a clean, consolidated view of the whole diff, not per-task.

**Input:** Codebase path + worktree path + scope (changed files or full project)
**Output:** `VERIFICATION_RESULT` structured report — gate status (pass/fail), per-check results, actionable findings

## When to Use

- Dispatched by `job-orchestrator` after each task-implementer wave (mandatory)
- Dispatched by `job-orchestrator` after each fix iteration
- Run standalone: "verify my code", "run quality gate", "/code-verifier"
- Any time you need a reproducible, structured view of project health

## Architecture: 4 Phases

```
Phase 1: DETECT   →  Auto-detect stack, tooling, commands
Phase 2: RUN      →  Execute lint → type-check → tests → import-check
Phase 3: ANALYZE  →  Parse outputs, classify findings by severity
Phase 4: REPORT   →  Emit VERIFICATION_RESULT
```

---

## Workflow

```
Code Verifier Progress:
- [ ] Phase 1: Detect stack and tooling
- [ ] Phase 2: Run verification checks
- [ ] Phase 3: Analyze and classify findings
- [ ] Phase 4: Report results
```

---

### Phase 1: DETECT

Determine scope. Stack and tool discovery is delegated to `keryx health run`
and `keryx test run` — do NOT hand-roll package-manager or
lint/type-check/test tool detection here.

**1.1 Determine scope:**

```
IF scope = "changed" (default when dispatched by orchestrator):
  FILES = git diff --name-only <base_branch>...HEAD
  Pass --changed to keryx health run and keryx test run below.

IF scope = "full":
  Run all checks on the full project (omit --changed).
```

**1.2 Checks used:**

| Check | Command |
|---|---|
| Lint + type-check | `keryx health run --changed --source eslint,typescript` (drop `--changed` for full scope) |
| Tests | `keryx test run --changed --strict` (drop `--changed` for full scope) |
| Circular imports | the project's own package-manager runner + `madge --circular --extensions ts,tsx src/`, if `madge` is a devDependency — optional; not covered by `keryx health run` / `keryx test run` |

`src/health/sources/eslint.ts` and `src/health/sources/typescript.ts` resolve
the real lint/type-check invocation for the project; `src/testing/service.ts`
detects `bun` / `pnpm` / `yarn` / `npm` from the lockfile and builds the test
invocation from the project's own test script. Do NOT hard-code a package
manager, linter, type-checker, or test binary here — that is the if-chain
these commands already resolve. On a project with no keryx health/testing
config, fall back to the project's own configured lint/type-check/test
command (discovered from its `package.json` scripts or equivalent, not a
hardcoded tool).

**Output of Phase 1:**
```
TOOLING:
  checks_available: [lint+type-check, tests, circular-imports]
  checks_skipped: [<reason>]
  scope: changed | full
  changed_files: [<paths>]
```

---

### Phase 2: RUN

Execute each available check. Capture full output.

**Execution order:** lint+type-check → tests → import-check

**Do NOT abort early** — run all checks even if one fails. The orchestrator needs the complete picture.

**2.1 Lint + type-check:**
```bash
keryx health run --changed --source eslint,typescript
# OR, full scope:
keryx health run --source eslint,typescript
```

Read the result with `keryx health status` (or the report path the command
prints). Capture:
- Gate status (pass/fail) per source
- Number of errors and warnings
- Per-finding: file, line, column, rule/TS code, message

**2.2 Tests:**
```bash
keryx test run --changed --strict
# OR, full scope:
keryx test run --strict
```

Capture:
- Report status / exit code
- Tests passed / failed / skipped counts
- Per-failure: test name, file, error message, stack (first 5 lines)

**2.3 Circular import check (if madge available):**
```bash
<pm> exec madge --circular --extensions ts,tsx src/ 2>&1
```
`<pm>` is the project's own package-manager runner for devDependency
binaries (`pnpm exec`, `yarn`, or the npm-based equivalent), resolved the
same way `keryx test run` resolves it from the lockfile — not hardcoded.

Capture:
- Exit code
- List of circular chains (if any)

---

### Phase 3: ANALYZE

Parse raw outputs into structured findings. Classify by severity.

**3.1 Severity classification:**

| Finding | Severity |
|---|---|
| Type error | CRITICAL |
| Test failure | CRITICAL |
| ESLint error (not warning) | HIGH |
| Circular import | HIGH |
| ESLint warning | LOW |
| Skipped test | INFO |

**3.2 Gate decision:**

```
GATE = PASS
IF any CRITICAL findings  → GATE = FAIL (blocks proceed)
IF any HIGH findings      → GATE = FAIL (blocks proceed)
IF only LOW/INFO findings → GATE = PASS_WITH_WARNINGS
```

**3.3 Actionable finding format:**

Each finding must include enough context for `task-implementer` (fix mode) to resolve it without re-reading the full output:

```
{
  severity: CRITICAL | HIGH | LOW | INFO,
  check: lint | type-check | test | circular-import,
  file: <path>,
  line: <N> | null,
  column: <N> | null,
  rule: <ESLint rule or TS error code> | null,
  message: <error text>,
  suggestion: <optional fix hint>
}
```

---

### Phase 4: REPORT

Emit the structured `VERIFICATION_RESULT` as the final message.

```
VERIFICATION_RESULT:
  gate: PASS | PASS_WITH_WARNINGS | FAIL
  scope: changed | full
  
  checks:
    lint:
      status: pass | fail | skipped
      errors: <N>
      warnings: <N>
      command_used: "<command>"
    
    type_check:
      status: pass | fail | skipped
      errors: <N>
      command_used: "<command>"
    
    tests:
      status: pass | fail | skipped
      passed: <N>
      failed: <N>
      skipped: <N>
      command_used: "<command>"
    
    circular_imports:
      status: pass | fail | skipped
      cycles: <N>
  
  findings:
    - severity: CRITICAL
      check: type-check
      file: src/services/UserService.ts
      line: 42
      rule: TS2345
      message: "Argument of type 'string' is not assignable to parameter of type 'number'"
    - severity: HIGH
      check: lint
      file: src/components/Form.tsx
      line: 18
      rule: "no-unused-vars"
      message: "'value' is defined but never used"
  
  summary: "<1-2 sentence human-readable summary>"
```

**STATUS reporting:**

```
STATUS: DONE          — gate PASS or PASS_WITH_WARNINGS, report follows
STATUS: DONE_WITH_CONCERNS — PASS_WITH_WARNINGS with notable warnings
STATUS: BLOCKED       — could not run checks (missing tooling, wrong directory)
```

> If `gate: FAIL` → STATUS is still `DONE` (the gate result, not the skill's execution). The orchestrator reads `gate: FAIL` and decides to trigger fix.

---

## Integration with job-orchestrator

The orchestrator dispatches `code-verifier` at two points:

**After task-implementer wave (pre-review gate):**
```
code-verifier:
  codebase_path: <worktree_path>
  scope: changed
  base_branch: <base_branch from JOB_STATE>
→ If gate: FAIL → dispatch fix tasks → re-run code-verifier
→ If gate: PASS → proceed to review
```

**After fix iterations (post-fix gate):**
```
code-verifier:
  codebase_path: <worktree_path>
  scope: changed
→ If gate still FAIL after 3 iterations → report as BLOCKED, skip to report
→ If gate: PASS → proceed to report
```

**The orchestrator's internal "checks" step (2.8) is replaced by `code-verifier` dispatch.**

---

## Standalone Usage

```bash
# Run on current directory, changed files only
/code-verifier

# Run on specific project
/code-verifier --path /path/to/project

# Full project scan (not just changed files)
/code-verifier --scope full
```

---

## Automation Settings

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `scope` | `changed` | `changed` / `full` | Limit checks to changed files or run full project |
| `fail_on_warnings` | `false` | true/false | Treat ESLint warnings as gate failures |
| `include_circular` | `true` | true/false | Run circular import detection if madge available |
| `max_findings_reported` | `20` | 1-100 | Cap findings in report to avoid overflow |

---

## Error Handling

| Error | Action |
|---|---|
| Check command not found | Mark check as `skipped`, continue others |
| Wrong working directory | ABORT with `STATUS: BLOCKED` and directory hint |
| Command times out (>120s) | Mark check as `skipped (timeout)`, continue |
| Zero checks available | `STATUS: BLOCKED` — cannot verify without any tooling |
| Circular import tool missing | Skip silently (not installed in all projects) |

---

## Rules of Engagement

1. **Run ALL checks** — never abort after first failure. The orchestrator needs the full picture.
2. **Do NOT modify files** — this is read-only verification.
3. **Scope to changed files** by default — full scans are slow and produce noise.
4. **Be specific** in findings — include file, line, rule, message. Vague "lint failed" is not actionable.
5. Return `VERIFICATION_RESULT` as the **final message** to the orchestrator.

---

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "Lint already failed, so running the type-check and tests adds nothing." | Rule 1: run ALL checks. The orchestrator sizes one fix wave from the full picture. Aborting early means it fixes lint, re-dispatches, then discovers the type errors — one wave per check instead of one wave. |
| "This type error is a one-line fix — faster to correct it than to report it." | Rule 2: this gate is read-only. A verifier that edits has verified its own edit, and the diff the reviewer sees no longer matches what the implementer wrote. Report it; let the fix come back through the loop. |
| "The lint binary isn't installed, so there is nothing wrong — the gate passes." | A check that did not run is `status: skipped`, never `pass`. `gate: PASS` on an empty check set is a false all-clear, and zero checks available is `STATUS: BLOCKED` by the Error Handling table. |
| "`gate: FAIL`, so my STATUS must be BLOCKED." | STATUS reports whether THIS SKILL ran, not what it found. A complete report of a failing gate is `STATUS: DONE`. `BLOCKED` tells the orchestrator verification never happened and it must resolve tooling — a different, wrong branch. |
| "That failing test is unrelated to the diff, so I'll record it as skipped." | `skipped` means it did not run. A failure you judged out of scope is still `failed`, with a finding. Deciding what is in scope is the orchestrator's call, and it cannot make it on a result you rewrote. |
| "I hit `max_findings_reported`, so the remaining findings can go unmentioned." | The cap limits the list, not the count. Report the true totals in `checks:` and say in `summary` that the finding list is truncated, or the orchestrator plans a fix wave against a number that is quietly too small. |

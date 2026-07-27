---
name: code-verifier
description: "Use when running a full quality gate after implementation — lint, type-check, tests, and import validation. Mandatory step in job-orchestrator after task-implementer and after fix iterations. Use standalone when you need a structured verification report."
triggers:
  - "Run verification"
  - "Quality gate"
  - "Check code quality"
  - "Run lint and tests"
  - "Verify implementation"
  - "Run checks"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "verification"
  agent_worthy: true
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
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

Auto-detect the project stack and available verification tools.

**1.1 Package manager and runner:**

```bash
cd <codebase_path>

if   [ -f bun.lockb ];         then PM=bun;    RUNNER="bun run"
elif [ -f pnpm-lock.yaml ];    then PM=pnpm;   RUNNER="pnpm run"
elif [ -f yarn.lock ];         then PM=yarn;   RUNNER="yarn"
elif [ -f package-lock.json ]; then PM=npm;    RUNNER="npm run"
elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then PM=python; RUNNER=""
elif [ -f go.mod ];            then PM=go;     RUNNER=""
else PM=unknown; RUNNER=""
fi
```

**1.2 Detect available check commands:**

| Check | How to detect | Command |
|---|---|---|
| Lint | `package.json` has `"lint"` script | `$RUNNER lint` |
| Lint (auto) | `eslint.config.*` or `.eslintrc*` present | `npx eslint . --max-warnings 0` |
| Biome | `biome.json` present | `npx biome check .` |
| Type-check | `package.json` has `"type-check"` or `"typecheck"` script | `$RUNNER type-check` |
| Type-check (auto) | `tsconfig.json` present | `npx tsc --noEmit` |
| Tests | `package.json` has `"test"` script | `$RUNNER test --run` (vitest) or `$RUNNER test` |
| pytest | `pytest` in `pyproject.toml` or `requirements.txt` | `pytest --tb=short -q` |
| Go tests | `go.mod` present | `go test ./...` |
| Circular imports | `madge` in devDependencies | `npx madge --circular src/` |

**1.3 Determine scope:**

```
IF scope = "changed" (default when dispatched by orchestrator):
  FILES = git diff --name-only <base_branch>...HEAD
  Run tests only for files related to changed code
  Run lint only on changed files: npx eslint <changed_files>
  Run type-check on full project (tsc doesn't support file-level scope)

IF scope = "full":
  Run all checks on full project
```

**Output of Phase 1:**
```
TOOLING:
  pm: bun | pnpm | yarn | npm | python | go | unknown
  runner: "bun run" | ...
  checks_available: [lint, type-check, tests, circular-imports]
  checks_skipped: [<reason>]
  scope: changed | full
  changed_files: [<paths>]
```

---

### Phase 2: RUN

Execute each available check in order. Capture full output.

**Execution order:** lint → type-check → tests → import-check

**Do NOT abort early** — run all checks even if one fails. The orchestrator needs the complete picture.

**2.1 Lint:**
```bash
# Changed files only (faster, more actionable)
npx eslint <changed_files> --format=json --max-warnings 0
# OR if lint script exists:
$RUNNER lint
```

Capture:
- Exit code (0 = pass, non-zero = fail)
- Number of errors and warnings
- Per-file error list (file path, line, column, rule, message)

**2.2 Type-check:**
```bash
npx tsc --noEmit 2>&1
# OR:
$RUNNER type-check
```

Capture:
- Exit code
- Number of errors
- Per-error: file, line, column, message, TS error code

**2.3 Tests:**
```bash
$RUNNER test --run 2>&1        # vitest
# OR: npx jest --ci 2>&1
# OR: pytest --tb=short -q 2>&1
# OR: go test ./... 2>&1
```

Capture:
- Exit code
- Tests passed / failed / skipped counts
- Per-failure: test name, file, error message, stack (first 5 lines)

**2.4 Circular import check (if madge available):**
```bash
npx madge --circular --extensions ts,tsx src/ 2>&1
```

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
→ If gate still FAIL after 2 iterations → report as BLOCKED, skip to report
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

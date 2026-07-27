---
name: tests-creator
description: "Converts acceptance criteria into failing test stubs (RED phase of TDD) before any implementation. Autonomous sub-agent — runs between issue-analyzer and task-implementer. Use when: generating test specs from acceptance criteria, enforcing TDD in the implementation pipeline."
triggers:
  - "Create tests"
  - "Write tests first"
  - "Generate test specs"
  - "Tests before implementation"
  - "TDD test stubs"
  - "Convert criteria to tests"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "testing"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Tests Creator

## Purpose

Converts acceptance criteria into concrete, failing test stubs **before any implementation code is written**. Enforces the RED phase of TDD.

**Input:** Task object with `acceptance_criteria` + codebase path
**Output:** Committed test files (RED) + `test_case_specs` block for `task-implementer`

## When to Use

- Between `issue-analyzer` and `task-implementer` in the TDD pipeline
- Before writing any implementation code for a task

## Quick Reference

### Phase Summary
1. **DETECT** — find test framework, read existing tests for conventions
2. **ANALYZE** — map each acceptance criterion to happy path + edge + error scenarios
3. **GENERATE** — write failing test stubs using forward-declared API
4. **REPORT** — emit `TEST_CASE_SPECS` block

### Key Rule
Tests MUST FAIL before implementation. Run `<test command>` to verify RED state.

### Output Format
```
TEST_CASE_SPECS:
  framework: vitest
  test_files:
    - path: src/__tests__/UserValidator.test.ts
      target_module: src/services/UserValidator.ts
      test_count: 4
      tests:
        - id: test-1
          description: "should accept valid email address"
          criterion: "User can register with valid email"
          type: happy_path
          status: written
  run_command: "bun test src/__tests__/UserValidator.test.ts"
  expected_result: "all failing (RED phase)"

STATUS: DONE
tests_written: 4
all_criteria_covered: true
```

### Status Protocol
```
STATUS: DONE            — all criteria covered, tests committed, RED verified
STATUS: DONE_WITH_CONCERNS — some criteria ambiguous, tests written with assumptions
STATUS: BLOCKED         — cannot determine test framework or API shape
STATUS: NEEDS_CONTEXT   — acceptance criteria missing, need task description
```

See full workflow in `.metaproject/skills/gdskills/quality/tests-creator/SKILL.md`

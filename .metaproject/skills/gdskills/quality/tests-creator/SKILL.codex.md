---
name: tests-creator
description: "Converts acceptance criteria into failing test stubs (RED phase of TDD) before any implementation. Autonomous sub-agent — runs between issue-analyzer and task-implementer. Use when: generating test specs from acceptance criteria, enforcing TDD in the implementation pipeline."
triggers:
  - "Create tests"
  - "Write tests first"
  - "Generate test specs"
  - "Tests before implementation"
  - "TDD test stubs"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "testing"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Tests Creator

## Purpose

Converts acceptance criteria into failing test stubs that task-implementer will make pass.

**Input:** Task with `acceptance_criteria` + codebase path
**Output:** Failing test files (RED phase) + `TEST_CASE_SPECS` report

## Execution Steps

1. **Detect framework** — check `package.json`, read existing test files
2. **Map criteria** — each criterion → happy path + edge cases + error paths
3. **Generate stubs** — write test files with forward-declared assertions (will fail)
4. **Commit** — `git commit -m "test: add failing stubs for <task>"`
5. **Verify RED** — run tests, confirm all fail
6. **Report** — emit `TEST_CASE_SPECS` block

## Output Template

```
TEST_CASE_SPECS:
  framework: <vitest|jest|pytest|bun:test>
  test_files:
    - path: <test file path>
      target_module: <source file to implement>
      test_count: <N>
      tests:
        - id: test-<N>
          description: "<it description>"
          criterion: "<acceptance criterion>"
          type: happy_path | edge_case | error_path
          status: written
  run_command: "<test command>"
  expected_result: "all failing (RED phase)"

STATUS: DONE
tests_written: <N>
all_criteria_covered: true | false
```

## Iron Laws
- NEVER write implementation code — only test files
- Tests MUST FAIL before reporting DONE
- Every acceptance criterion needs ≥1 test

See full workflow: `.metaproject/skills/gdskills/quality/tests-creator/SKILL.md`

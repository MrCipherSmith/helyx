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

Converts acceptance criteria into failing test stubs before implementation (RED phase of TDD).

**Position in pipeline:** issue-analyzer → tests-creator → task-implementer

## Phases
1. **DETECT** — test framework, conventions from existing tests
2. **ANALYZE** — map criteria to test scenarios (happy/edge/error)
3. **GENERATE** — write failing test stubs with real assertions
4. **REPORT** — emit TEST_CASE_SPECS

## Key Rules
- Only writes test files, never implementation
- Tests MUST fail before reporting done
- Every acceptance criterion → ≥1 test

## Output
```
TEST_CASE_SPECS:
  framework: <framework>
  test_files: [...]
  run_command: "<test command>"
  expected_result: "all failing (RED phase)"

STATUS: DONE
tests_written: <N>
all_criteria_covered: true
```

Full workflow: `.metaproject/skills/gdskills/quality/tests-creator/SKILL.md`

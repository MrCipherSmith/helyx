---
name: tests-creator
description: "Converts acceptance criteria into failing test stubs (RED phase of TDD) before any implementation. Autonomous sub-agent — runs between issue-analyzer and task-implementer. Use when: generating test specs from acceptance criteria, enforcing TDD in the implementation pipeline."
triggers:
  - "Create tests"
  - "Write tests first"
  - "Generate test specs"
  - "Tests before implementation"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "testing"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Tests Creator

Converts acceptance criteria → failing test stubs (RED phase).

**Pipeline position:** issue-analyzer → **tests-creator** → task-implementer

## Steps
1. Detect test framework (`package.json`, existing tests)
2. Map each acceptance criterion to test scenarios
3. Write failing test stubs (forward-declared API calls)
4. Commit test files
5. Run tests — verify RED state
6. Report `TEST_CASE_SPECS`

## Output
```
TEST_CASE_SPECS:
  framework: vitest
  test_files: [{ path, target_module, test_count, tests: [...] }]
  run_command: "bun test ..."
  expected_result: "all failing (RED phase)"

STATUS: DONE
tests_written: N
all_criteria_covered: true
```

Full spec: `.metaproject/skills/gdskills/quality/tests-creator/SKILL.md`

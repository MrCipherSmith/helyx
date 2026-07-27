---
name: tests-creator
description: "Use when writing test cases BEFORE implementation — converts acceptance criteria into failing test stubs that task-implementer will make pass. Mandatory step in the TDD pipeline between issue-analyzer and task-implementer."
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
  agent_worthy: true
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Tests Creator

## Purpose

Converts acceptance criteria (from `issue-analyzer` or manual input) into concrete, failing test stubs **before any implementation code is written**. Enforces the RED phase of TDD.

**Input:** Task object with `acceptance_criteria` + codebase path + test framework info
**Output:** Ready-to-run test files with failing test stubs + `test_case_specs` block for `task-implementer`

## When to Use

- Between `issue-analyzer` and `task-implementer` in the TDD pipeline
- Orchestrator needs test specs before dispatching implementation
- User wants to review test expectations before code is written
- Acceptance criteria need to be translated into executable specifications

## Architecture: 4 Phases

```
Phase 1: DETECT    →  Identify test framework, conventions, fixture patterns
Phase 2: ANALYZE   →  Map acceptance criteria to test scenarios
Phase 3: GENERATE  →  Write failing test stubs with correct framework syntax
Phase 4: REPORT    →  Emit test_case_specs for task-implementer consumption
```

---

## Workflow

```
Tests Creator Progress:
- [ ] Phase 1: Detect test framework and conventions
- [ ] Phase 2: Map acceptance criteria to test scenarios
- [ ] Phase 3: Generate failing test stubs
- [ ] Phase 4: Report test_case_specs
```

---

### Phase 1: DETECT

Identify the test framework and conventions used in the project.

**1.1 Detect framework:**

```bash
# Check package.json for test dependencies
cat <codebase_path>/package.json | grep -E '"(jest|vitest|mocha|jasmine|bun:test|pytest|go test)"'

# Check for config files
ls <codebase_path>/{vitest.config.*,jest.config.*,pytest.ini,setup.cfg}

# Check existing test files for imports
find <codebase_path>/src -name "*.test.*" -o -name "*.spec.*" | head -5
```

**1.2 Read 2-3 existing test files** to understand:
- Import style (`import { describe, it, expect } from 'vitest'` vs global)
- Test file location (co-located `*.test.ts` vs `__tests__/` directory)
- Describe/it/test nesting patterns
- Common assertion patterns (`expect(x).toBe(y)` vs `assert.equal(x, y)`)
- Mock patterns (`vi.fn()` vs `jest.fn()` vs manual mocks)
- Fixture/factory patterns (how test data is created)
- Before/after hook usage

**1.3 Identify test file naming:**
- Pattern: `<component>.test.ts`, `<service>.spec.ts`, `test_<module>.py`, etc.
- Location: co-located with source or in `__tests__`/`tests/` directory

**Output of Phase 1:**
```
TEST_ENV:
  framework: vitest | jest | bun:test | mocha | pytest | go_test
  import_style: esm | cjs | global
  file_pattern: "*.test.ts" | "*.spec.ts" | "test_*.py"
  file_location: co-located | __tests__ | tests/
  assertion_style: expect | assert | chai
  mock_library: vi | jest | sinon | unittest.mock
  fixture_pattern: <description of how test data is created>
```

---

### Phase 2: ANALYZE

Map each acceptance criterion to one or more test scenarios.

**2.1 Parse acceptance criteria:**

For each criterion, determine:
- **Happy path**: when everything works correctly
- **Edge cases**: boundary values, empty inputs, maximum values
- **Error paths**: invalid input, missing data, permission denied, external failure

**2.2 Criterion-to-scenario mapping:**

| Criterion Type | Test Scenarios to Generate |
|---|---|
| "User can X" | happy path: user can X; error: user cannot X when [condition] |
| "System returns Y when Z" | given Z → returns Y; given not-Z → does not return Y |
| "Field is required" | valid data passes; missing field fails with error |
| "Value must be between A and B" | A passes; B passes; A-1 fails; B+1 fails |
| "X must not happen" | verify X does not happen under [conditions] |
| "Async operation completes" | resolves with expected value; rejects on failure |

**2.3 Group scenarios by test file:**

Group related scenarios into test files matching the target_files from the task:
- Service test → test the service class methods
- Component test → test component rendering and interactions
- Integration test → test the full flow

**Output of Phase 2:**
```
TEST_PLAN:
  - test_file: <path>
    target_module: <source file being tested>
    scenarios:
      - id: test-1
        criterion: <which acceptance criterion>
        description: <what to test>
        type: happy_path | edge_case | error_path
        setup: <what to arrange>
        action: <what to call/render/trigger>
        assertion: <what to expect>
```

---

### Phase 3: GENERATE

Write the actual test files with failing stubs.

**3.1 Test file structure:**

```typescript
// Template for TypeScript (vitest/jest)
import { describe, it, expect, vi, beforeEach } from 'vitest';
// import the module under test — may not exist yet, that is expected
import { <ModuleUnderTest> } from '<relative path>';

describe('<ModuleUnderTest>', () => {
  // Acceptance criterion: <criterion text>
  describe('<group name>', () => {
    it('<should do X when Y>', async () => {
      // Arrange
      const <fixture> = <test data>;

      // Act
      const result = await <action>;

      // Assert
      expect(result).<assertion>;
    });

    it('<should fail when Z>', async () => {
      // Arrange
      const <invalid fixture> = <invalid data>;

      // Act & Assert
      await expect(<action with invalid data>).rejects.toThrow(<error type>);
    });
  });
});
```

**3.2 Failing stubs (RED phase):**

The generated tests MUST:
- Import the module under test (file may not exist yet — that is fine)
- Have meaningful test descriptions
- Have placeholder assertions that will FAIL until implementation:
  ```typescript
  // Use todo() for unimplemented tests
  it.todo('<test description>');
  
  // OR use a stub assertion that fails
  it('<test description>', () => {
    expect(true).toBe(false); // RED: remove this when implementing
  });
  ```
- OR use proper assertions calling the future API (will fail with "module not found" or "function is not a function")

**3.3 Preferred approach — forward-declared tests:**

Write tests that call the actual future API with real assertions. They will fail because the module doesn't exist yet:

```typescript
// This file will fail to compile/run until task-implementer creates:
// src/services/UserValidator.ts with a validate() method
import { UserValidator } from '../services/UserValidator';

describe('UserValidator', () => {
  it('should accept valid email address', () => {
    const validator = new UserValidator();
    expect(validator.validate({ email: 'user@example.com' })).toEqual({ valid: true });
  });

  it('should reject email without @ symbol', () => {
    const validator = new UserValidator();
    expect(validator.validate({ email: 'not-an-email' })).toEqual({
      valid: false,
      errors: [{ field: 'email', message: 'Invalid email format' }],
    });
  });
});
```

**3.4 Commit the test files:**

```bash
git add <test files>
git commit -m "test(<scope>): add failing test stubs for <task description>

RED phase — tests will pass after implementation
refs #<issue_number>"
```

---

### Phase 4: REPORT

Emit the `test_case_specs` block for consumption by `task-implementer`.

**Output structure:**

```
TEST_CASE_SPECS:
  framework: <vitest|jest|pytest|...>
  test_files:
    - path: <test file path>
      target_module: <source file to implement>
      test_count: <N>
      tests:
        - id: test-1
          description: <it description>
          criterion: <which acceptance criterion>
          type: happy_path | edge_case | error_path
          status: written  # test file exists, test is RED

  run_command: "<command to run just these tests>"
  expected_result: "all failing (RED phase)"
  notes: "<any test design decisions or assumptions>"
```

**STATUS reporting:**

```
STATUS: DONE
tests_written: <N>
test_files: [<list of paths>]
all_criteria_covered: true | false (with explanation)
```

---

## Integration with Task Implementer

When `task-implementer` receives a task that includes `test_case_specs`:

1. Read the test files (already committed as RED)
2. Run the tests — confirm they FAIL
3. Implement code until all tests are GREEN
4. Commit the implementation
5. Re-run tests — confirm GREEN
6. Report SUCCESS

This ensures the TDD cycle is maintained end-to-end.

---

## Automation Settings

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `commit_test_stubs` | `true` | true/false | Commit the test files after generation |
| `verify_red` | `true` | true/false | Run tests to confirm they fail before reporting |
| `stub_style` | `forward_declared` | `forward_declared` / `todo` | How to write failing stubs |
| `include_edge_cases` | `true` | true/false | Generate edge case tests in addition to happy path |
| `max_tests_per_criterion` | `3` | 1-5 | Max test cases per acceptance criterion |

---

## Error Handling

| Error | Action |
|-------|--------|
| No acceptance criteria provided | Derive from task description — log warning |
| Test framework not detected | Ask via output, default to vitest for TypeScript |
| Test file already exists | Read existing tests, add new stubs without overwriting |
| Module path unknown | Use placeholder path, note in test_case_specs |
| Verify-red fails (tests pass before implementation) | This means the test is wrong — fix the assertion or report as concern |

---

## Rules of Engagement

1. **DO NOT** write any implementation code. This skill only writes test files.
2. **DO NOT** write tests that pass without implementation — RED means failing.
3. **DO** write tests that describe WHAT the code should do, not HOW.
4. **DO** cover every acceptance criterion with at least one test.
5. **DO** follow the project's existing test conventions (discovered in Phase 1).
6. **DO** commit the test files before reporting.
7. Return `TEST_CASE_SPECS` as the final message to the orchestrator/caller.

---

## Job Context Awareness

When dispatched by `job-orchestrator`:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided, read the context document to understand:
- Which test frameworks are in use
- Testing conventions and patterns from the codebase
- Mock/stub strategies documented in the project

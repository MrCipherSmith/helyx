---
name: test-gen
description: "Use when unit or integration tests need to be written for a specific file or module that already exists. NOT for writing failing test stubs ahead of the implementation (use `tests-creator`)."
triggers:
  - "generate tests"
  - "write tests"
  - "add coverage"
  - "Write tests for"
  - "Add tests"
  - "Create test file"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Test Generator

Auto-generate tests for specified files or modules.

## Arguments

- `/test-gen <file>` — generate tests for specific file
- `/test-gen <directory>` — tests for all files in directory
- `/test-gen --integration` — focus on integration tests
- `/test-gen --coverage` — run with coverage report after

## Workflow

### Step 1: Understand the Target
1. Read the target file(s)
2. Identify: exports, functions, classes, API endpoints, React components
3. Map dependencies and side effects

### Step 2: Discover Testing Patterns
1. Find test framework (Jest, Vitest, Pytest) from configs
2. Find test file location convention from existing tests
3. Read 1-2 neighboring test files to match: import style, describe/it structure, mock patterns, assertion style

### Step 3: Plan Test Cases

**Functions:** happy path, edge cases (empty/null/zero/negative), error cases, boundary values

**Components:** renders, props, interactions, conditional rendering, states

**Endpoints:** success (200), validation (400), not found (404), auth (401/403)

**Classes:** constructor, methods, state transitions, errors

### Step 4: Generate
1. Create test file at correct path (matching convention)
2. Write imports matching project style
3. Generate grouped test cases with appropriate mocks
4. One assertion per test where practical

### Step 5: Verify
```bash
keryx test run --changed --strict
```
`src/testing/service.ts` detects the project's own test runner from its
lockfile/scripts and builds the invocation — do not hard-code a test runner
or binary here. On a project with no keryx testing config, run the project's
own configured test command instead (discovered, not hardcoded).

Fix failing tests (max 3 iterations) — fix the test, not the source.

### Step 6: Report
```
✅ Generated: src/utils/__tests__/helper.test.ts
   - 12 test cases, all passing ✓
```

## Rules

- ALWAYS match existing test patterns in the project
- NEVER modify source code — only test files
- Mock external dependencies, not internal modules
- Meaningful test descriptions
- If no test framework detected, suggest installing one

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The test fails because the source has a bug — I'll fix the source" | This skill writes test files only. A source change buried inside a test-generation run is an unreviewed fix, and it also hides the bug the new test just found. Report the failure instead |
| "Still failing on iteration four; I'll loosen the assertion until it's green" | A test that asserts nothing covers nothing while reporting coverage — strictly worse than no test. After 3 iterations, stop and report the failing case |
| "No test framework here, so I'll install vitest and a config" | Choosing a test framework is a project decision with config, CI and convention consequences. Suggest one; do not add it |
| "Mocking the neighbouring module is easier than building its input" | Mock external dependencies, not internal ones. A test whose collaborators are all mocked asserts that your mocks agree with each other |
| "One test that exercises the whole file covers more per line written" | It reports one failure for any of a dozen causes, so nobody can tell what broke. One behaviour per test, and let the description name it |

## Verification

Do not report generation as done until all of the following hold:

- The test file sits at the project's own convention path, with the import style, describe/it structure and assertion style of the neighbouring tests read in Step 2
- `keryx test run --changed --strict` — or, with no keryx testing config, the project's own discovered test command — exits 0 with every generated test passing
- `git status` shows only test files added or modified; no source file changed
- Every exported function, component, endpoint or class identified in Step 1 has at least one test, or the report says why it does not
- The Step 6 report states the file path and the test-case count, and that count matches what the runner reported

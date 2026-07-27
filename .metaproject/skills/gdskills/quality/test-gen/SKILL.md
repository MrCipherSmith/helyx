---
name: test-gen
description: "Use when unit or integration tests need to be written for a specific file or module."
triggers:
  - "/test-gen"
  - "Generate tests"
  - "Write tests for"
  - "Add tests"
  - "Create test file"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "testing"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
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
npx jest <test-file> --no-coverage
```
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

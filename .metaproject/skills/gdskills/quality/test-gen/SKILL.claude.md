---
description: Auto-generate tests for a specified file or module
allowed-tools: Bash(*), Read(*), Write(*), Glob(*)
---

## Context

- Test framework: !`cat package.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); deps={**d.get('dependencies',{}),**d.get('devDependencies',{})}; print(next((k for k in ['bun:test','vitest','jest'] if k in str(deps)), 'unknown'))" 2>/dev/null || echo "unknown"`
- Existing tests: !`find . -name "*.test.ts" -not -path "*/node_modules/*" 2>/dev/null | head -5 || echo "none"`
- Sample test style: !`find . -name "*.test.ts" -not -path "*/node_modules/*" 2>/dev/null | head -1 | xargs head -30 2>/dev/null || echo "none"`

## Your task

Generate tests for: $ARGUMENTS

1. **Read** the target file completely
2. **Check** for existing tests (`<name>.test.ts` or `__tests__/<name>.ts`)
3. **Plan** test cases:
   - Happy path for each export
   - Edge cases: empty, null, boundary values
   - Error cases: invalid input, exceptions, DB errors
   - API routes: each method + auth + 200/400/401/404/500
4. **Write** tests matching existing style:
   - bun:test → `import { describe, test, expect, mock } from "bun:test"`
   - jest/vitest → respective imports
   - Mock external dependencies at correct boundary
5. **Write** test file to `<name>.test.ts` (same dir) or `__tests__/` if that's the convention
6. **Run** and fix: `bun test <file> 2>/dev/null || npx jest <file> 2>/dev/null`

Report: tests generated, estimated coverage, cases needing manual work.

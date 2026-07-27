---
name: code-verifier
description: "Full quality gate: lint, type-check, tests, circular imports. Mandatory post-implementation step in job-orchestrator. Use when: verifying code after implementation, running quality gate before review, checking code health standalone."
triggers:
  - "Run verification"
  - "Quality gate"
  - "Run lint and tests"
  - "Verify implementation"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "verification"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Code Verifier

Full quality gate: lint → type-check → tests → circular imports.

**Position:** task-implementer → **code-verifier** → review

## Steps
1. Detect PM and tooling (bun/npm/pnpm/yarn/python/go)
2. Run lint (ESLint/Biome/ruff)
3. Run type-check (tsc --noEmit / mypy / pyright)
4. Run tests (vitest/jest/pytest/go test)
5. Check circular imports (madge, if available)
6. Classify findings by severity, determine gate
7. Emit VERIFICATION_RESULT

## Gate
- CRITICAL (type errors, test failures) or HIGH (lint errors, cycles) → GATE: FAIL
- LOW only → GATE: PASS_WITH_WARNINGS

## Output
```
VERIFICATION_RESULT:
  gate: PASS | PASS_WITH_WARNINGS | FAIL
  checks: { lint, type_check, tests, circular_imports }
  findings: [{ severity, check, file, line, rule, message }]
  summary: "..."

STATUS: DONE
```

Full spec: `.metaproject/skills/gdskills/orchestration/code-verifier/SKILL.md`

---
name: code-verifier
description: "Full quality gate: lint, type-check, tests, circular imports. Mandatory post-implementation step in job-orchestrator. Use when: verifying code after implementation, running quality gate before review, checking code health standalone."
triggers:
  - "Run verification"
  - "Quality gate"
  - "Run lint and tests"
  - "Verify implementation"
  - "Run checks"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "verification"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Code Verifier

Quality gate: lint → type-check → tests → circular imports.

**Position in pipeline:** task-implementer → **code-verifier** → review

## Execution
1. Auto-detect PM and available tools
2. Run ALL checks (never stop on first failure)
3. Gate: CRITICAL/HIGH findings = FAIL, LOW = PASS_WITH_WARNINGS

## Output
```
VERIFICATION_RESULT:
  gate: PASS | PASS_WITH_WARNINGS | FAIL
  checks: { lint, type_check, tests, circular_imports }
  findings: [{ severity, check, file, line, rule, message }]

STATUS: DONE | DONE_WITH_CONCERNS | BLOCKED
```

Full spec: `.metaproject/skills/gdskills/orchestration/code-verifier/SKILL.md`

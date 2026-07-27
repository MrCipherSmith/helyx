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

Quality gate sub-agent: lint → type-check → tests → circular imports.

**Pipeline position:** task-implementer → **code-verifier** → review

## Phases
1. **DETECT** — auto-detect PM (bun/pnpm/npm/yarn/python/go), available check commands
2. **RUN** — lint → type-check → tests → circular-import check (all, never abort early)
3. **ANALYZE** — classify findings: CRITICAL (type errors, test failures) | HIGH (lint errors, cycles) | LOW (warnings)
4. **REPORT** — emit `VERIFICATION_RESULT`

## Gate Logic
```
CRITICAL or HIGH findings → GATE: FAIL   (orchestrator triggers fix)
LOW/INFO only             → GATE: PASS_WITH_WARNINGS
No findings               → GATE: PASS
```

## Output
```
VERIFICATION_RESULT:
  gate: PASS | PASS_WITH_WARNINGS | FAIL
  checks:
    lint:         { status, errors, warnings, command_used }
    type_check:   { status, errors, command_used }
    tests:        { status, passed, failed, skipped, command_used }
    circular_imports: { status, cycles }
  findings:
    - { severity, check, file, line, rule, message }
  summary: "<human-readable>"

STATUS: DONE | DONE_WITH_CONCERNS | BLOCKED
```

**Key rule:** Always run ALL checks even if one fails — orchestrator needs complete picture.

Full spec: `.metaproject/skills/gdskills/orchestration/code-verifier/SKILL.md`

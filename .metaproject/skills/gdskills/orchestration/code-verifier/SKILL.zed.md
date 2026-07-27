---
name: code-verifier
description: "Full quality gate: lint, type-check, tests, circular imports. Mandatory post-implementation step in job-orchestrator. Use when: verifying code after implementation, running quality gate before review."
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

lint → type-check → tests → circular-import gate.

**Pipeline:** task-implementer → **code-verifier** → review

## Steps
1. Detect tooling
2. Run all checks (never abort early)
3. Classify: CRITICAL/HIGH = FAIL, LOW = PASS_WITH_WARNINGS
4. Emit VERIFICATION_RESULT

Full spec: `.metaproject/skills/gdskills/orchestration/code-verifier/SKILL.md`

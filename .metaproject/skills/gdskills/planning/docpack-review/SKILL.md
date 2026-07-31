---
name: docpack-review
description: "Use when reviewing or verifying a Metaproject requirements package under docs/requirements for completeness, versioning, README/PRD/spec consistency, schema references, roadmap updates, unsupported claims, and implementation-status accuracy. Usually dispatched by docpack-orchestrator. Not for reviewing autodoc-generated current-codebase documentation."
triggers:
  - "review requirements package"
  - "verify requirements package"
  - "requirements package review"
  - "check PRD spec consistency"
  - "проверь документацию"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# docpack-review

Adversarial reviewer for Metaproject requirements packages.

## Iron Laws

| # | Law |
|---|---|
| 1 | Review every file in the package; do not sample. |
| 2 | A missing required file is a blocker. |
| 3 | A missing `Version` field is a blocker. |
| 4 | Unsupported implementation claims are blockers. |
| 5 | Contradictions between README, PRD and spec are blockers. |
| 6 | Do not rewrite docs; report findings and suggested fixes. |

## Checklist

### Structure

- Required files exist: `README.md`, `prd.md`, `specification.md`.
- Optional files match topic needs.
- `schemas/*.json` are present when specification defines JSON contracts.

### Versioning

- Every Markdown file has `Version` under H1.
- Changed existing docs bumped version.

### Links

- README links to all package files.
- Specification links to schemas and related module specs.
- Roadmap links to the package when it represents a module/capability.

### Consistency

- README status matches PRD/spec.
- PRD goals map to specification acceptance criteria.
- Non-goals are not implemented as requirements.
- CLI/manifest/config names are consistent.

### Accuracy

- Runtime implementation is not claimed unless code exists.
- Future commands are marked future/planned.
- Integrations distinguish implemented, planned and optional.

## Output

Return findings first:

```text
STATUS: DONE | DONE_WITH_CONCERNS
verdict: PASS | PASS_WITH_WARNINGS | FAIL
blockers: <count>
warnings: <count>
findings:
- [BLOCKER|WARNING|INFO] <file>: <issue> -> <suggested fix>
audit:
- files_checked: <list>
- schemas_checked: <list>
- roadmap_checked: yes|no
```

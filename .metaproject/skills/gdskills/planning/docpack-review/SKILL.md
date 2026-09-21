---
name: docpack-review
description: "Use when reviewing or verifying a Metaproject requirements package under docs/requirements for completeness, versioning, README/PRD/spec consistency, schema references, roadmap updates, unsupported claims, and implementation-status accuracy. Usually dispatched by docpack-orchestrator. Not for reviewing autodoc-generated current-codebase documentation."
triggers:
  - "requirements package review"
  - "verify requirements package"
  - "check PRD spec consistency"
  - "проверь документацию"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
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

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "The three required files are clean, so the optional ones will be too." | Iron Law 1 forbids sampling. Optional files are where unsupported claims collect precisely because nobody expects them to be read — `agent-protocol.md` and `metrics-and-validation.md` describe behavior that most often does not exist yet. |
| "The PRD and the specification both say this command exists, so the claim is supported." | Two documents agreeing is one author repeating themselves. The Accuracy checks resolve against the repository, not against a sibling doc. If no code backs the claim, it is a blocker. |
| "The fix is one line — faster to apply it than to describe it." | Iron Law 6: report findings and suggested fixes, never rewrite. A reviewer who edits has no reviewer, and the orchestrator loses the record of what was wrong. |
| "It is only a missing `Version` field — that is a warning, not a blocker." | Iron Law 3 names it a blocker outright, as does a missing required file (Law 2). The severity is fixed by the law, not by how small the fix looks. |
| "There are blockers, but the package is broadly good, so `PASS_WITH_WARNINGS`." | Any blocker means `verdict: FAIL`. Softening the verdict is how a package with a missing spec reaches implementation. |
| "The README status is stale but harmless, so it is an INFO note." | README status disagreeing with the PRD or spec is a contradiction, and Iron Law 5 makes contradictions blockers. Stale status is the field implementers read first. |

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

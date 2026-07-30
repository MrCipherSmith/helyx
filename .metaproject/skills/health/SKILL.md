---
name: health
description: Use for code quality state - lint, type, test, coverage, dependency, and complexity health of the project, a module, or a file. Read the health report before claiming quality status or gate results.
---

# health Skill

Use this skill when a task needs the code quality state of the project, a
module, or a file: gate status, findings by priority, regressions, coverage, or
complexity hot-spots.

## Workflow

1. Prefer the curated summary `.metaproject/data/health/artifacts/latest.md`.
2. If it is stale or missing, run `keryx health run` (add `--strict` for CI-grade checks).
3. Use `keryx health explain <file-or-module>` for a specific scope.
4. Use `keryx health gate` for a CI exit code.
5. Treat findings as signals; verify against source code before acting.

## Commands

```bash
keryx health status
keryx health run --strict
keryx health gate --strict-warn
keryx health sources
keryx health explain src/example.ts
keryx health baseline update
```

## Notes

- Sources are required or optional; missing required sources fail the gate under `--strict`.
- Baseline is accept-current on first run; update it explicitly.
- The report is a versioned contract consumed by gdskills.

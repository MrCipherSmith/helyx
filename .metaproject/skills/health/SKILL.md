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
2. If it is stale or missing, run `gd-metapro health run` (add `--strict` for CI-grade checks).
3. Use `gd-metapro health explain <file-or-module>` for a specific scope.
4. Use `gd-metapro health gate` for a CI exit code.
5. Treat findings as signals; verify against source code before acting.

## Commands

```bash
gd-metapro health status
gd-metapro health run --strict
gd-metapro health gate --strict-warn
gd-metapro health sources
gd-metapro health explain src/example.ts
gd-metapro health baseline update
```

## Notes

- Sources are required or optional; missing required sources fail the gate under `--strict`.
- Baseline is accept-current on first run; update it explicitly.
- The report is a versioned contract consumed by gdskills.

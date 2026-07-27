# health Core

Local Code Health service layer.

Responsibilities:

- run/import quality sources through the `SourceAdapter` contract;
- normalize findings into the versioned finding schema;
- compute project/module/file metrics, scoring, and the quality gate;
- write layered outputs (Markdown summary, JSON report, raw logs);
- keep an accept-current baseline for regression detection.

Findings are a decoupled contract: gdskills consumes
`data/health/artifacts/latest.json` via `gd-metapro skills learn --from-health`.

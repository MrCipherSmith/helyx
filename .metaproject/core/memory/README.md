# memory Core

Local Documentation Memory service layer.

Responsibilities:

- read typed Markdown entries under `.metaproject/memory` (source of truth);
- build a deterministic inverted index under `.metaproject/data/memory/index`;
- rank search by relevance + recency + confidence + status + scope;
- ingest source artifacts as `draft` entries with provenance;
- run deterministic dedup/conflict checks.

Only `accepted` entries influence skills. Findings are a decoupled, versioned
contract consumed by gdskills via `gd-metapro skills learn --from-memory`.

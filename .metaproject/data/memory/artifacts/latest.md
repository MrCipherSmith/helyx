# Memory search: diverges

Results: 1

### 1. One rule in several files diverges, and review does not catch it  (score 2.498)
- type: known-mistake | status: accepted | confidence: high
- matched 1/1 terms; status accepted; confidence high
- scopes: module:utils, channel, scripts, mcp, entity:terminal parsing, permission prompt detection, status rendering
- provenance: manual
- summary: Seven flows in this repository on 2026-08-02, and the underlying defect was the same every time: one piece of knowledge written out in several places, then diverging. Reading the diff does not find it — the copies are outside the diff. Run `bun run dupes` instead of looking.
- entry: known-mistakes/duplicated-knowledge-diverges.md

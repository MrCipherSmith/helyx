# Memory search: status message Telegram escaping

Results: 2

### 1. Coverage programme: what is done, what is open, what is next  (score 1.747)
- type: task-note | status: accepted | confidence: high
- matched 1/4 terms; status accepted; confidence high
- scopes: module:utils, channel, scripts, mcp, memory, entity:coverage, terminal parsing, permission prompts, status rendering
- provenance: manual
- summary: An eight-flow programme run on 2026-08-02/03 to raise test coverage by extracting decisions into pure modules. Tests 326 → 696, coverage 15.71% → 19.22%, health 37 → 61. It found seven real bugs on the way. The arithmetic now says extraction is spent: the remaining uncovered code is I/O, and the next useful step is a fixture layer, not another extraction.
- entry: task-notes/coverage-programme-state.md

### 2. One rule in several files diverges, and review does not catch it  (score 1.744)
- type: known-mistake | status: accepted | confidence: high
- matched 1/4 terms; status accepted; confidence high
- scopes: module:utils, channel, scripts, mcp, entity:terminal parsing, permission prompt detection, status rendering
- provenance: manual
- summary: Seven flows in this repository on 2026-08-02, and the underlying defect was the same every time: one piece of knowledge written out in several places, then diverging. Reading the diff does not find it — the copies are outside the diff. Run `bun run dupes` instead of looking.
- entry: known-mistakes/duplicated-knowledge-diverges.md

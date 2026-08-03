# Memory search: flow-014 llm client SSE CRLF UTF-8 retry fake network recorder

Results: 3

### 1. Coverage programme: what is done, what is open, what is next  (score 1.952)
- type: task-note | status: accepted | confidence: high
- matched 5/11 terms; status accepted; confidence high
- scopes: module:utils, channel, scripts, mcp, memory, entity:coverage, terminal parsing, permission prompts, status rendering
- provenance: manual
- summary: An eight-flow programme run on 2026-08-02/03 to raise test coverage by extracting decisions into pure modules. Tests 326 → 696, coverage 15.71% → 19.22%, health 37 → 61. It found seven real bugs on the way. The arithmetic now says extraction is spent: the remaining uncovered code is I/O, and the next useful step is a fixture layer, not another extraction.
- entry: task-notes/coverage-programme-state.md

### 2. A comment that claims agreement is not a mechanism  (score 1.586)
- type: known-mistake | status: accepted | confidence: high
- matched 1/11 terms; status accepted; confidence high
- scopes: module:utils, channel, entity:permission prompt detection, status rendering
- provenance: manual
- summary: The recurring authoring mistake in this repository is not a logic error: it is a doc comment asserting more than the code below it does. It is invisible on re-reading, because the author reads what they meant. Every instance was caught by an independent reviewer, never by the author.
- entry: known-mistakes/comment-asserts-more-than-code.md

### 3. One rule in several files diverges, and review does not catch it  (score 1.586)
- type: known-mistake | status: accepted | confidence: high
- matched 1/11 terms; status accepted; confidence high
- scopes: module:utils, channel, scripts, mcp, entity:terminal parsing, permission prompt detection, status rendering
- provenance: manual
- summary: Seven flows in this repository on 2026-08-02, and the underlying defect was the same every time: one piece of knowledge written out in several places, then diverging. Reading the diff does not find it — the copies are outside the diff. Run `bun run dupes` instead of looking.
- entry: known-mistakes/duplicated-knowledge-diverges.md

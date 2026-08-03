# Flow Journal

- 2026-08-03T21:20:20.042Z - flow created
- 2026-08-03T21:20:20.135Z - task-added: T5: utils/llm-stream.ts — the decisions
- 2026-08-03T21:20:20.224Z - task-added: T6: rewire claude/client.ts onto it
- 2026-08-03T21:20:20.308Z - task-added: T7: llm-stream tests incl. chunk boundaries
- 2026-08-03T21:20:20.393Z - task-added: T8: reader loops against the fake network
- 2026-08-03T21:20:20.476Z - task-added: T9: full gate
- 2026-08-03T21:20:20.565Z - frozen: 8 criteria; checksum recorded
- 2026-08-03T21:20:20.649Z - started

## What happened

Two halves, and the second is what made the first worth doing.

The decisions came out first: line splitting, SSE classification, both chunk
parsers, the reasoning-block state machine, the retry predicate and its backoff,
provider selection. Extracting them takes `claude/client.ts` from 6% to nothing
by itself — the file loses the logic and keeps the loops, and a reader loop with
no decisions in it is still uncovered.

So the loops are driven too, against the fake network from flow 011: a body
arriving in chosen pieces, an event split across two reads, a multi-byte
character split mid-glyph, keep-alives, a malformed chunk, usage on the final
chunk. That is the half no pure function can prove, and it is where the buffer
and the decoder actually earn their place.

### Two things the tests found about themselves

A reply of `ok` never reaches `flush()`. It cannot become `<think>`, so it is
emitted on the first push — and the test that asserted otherwise was asserting a
misunderstanding of the filter rather than a property of it. `<th` is the case
that actually reaches the flush.

And a 500 costs fourteen seconds. `fetchOpenai` throws on 429 and 5xx precisely
so `withRetry` sees them, which is right in production and made the
"a failed request is an error" test time out. It uses 401 now, and says why —
the retry policy is asserted where it costs nothing.

### Numbers

`claude/client.ts`: 6.17% → 37.30% of lines, 0% → 65.22% of functions.
`utils/llm-stream.ts`: 100% of lines. Tests 886 → 930.
- 2026-08-03T21:20:46.111Z - task-done: T1: Collect remaining context
- 2026-08-03T21:20:46.200Z - task-done: T2: Implement per plan
- 2026-08-03T21:20:46.288Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T21:20:46.375Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T21:20:46.465Z - task-done: T5: utils/llm-stream.ts — the decisions
- 2026-08-03T21:20:46.554Z - task-done: T6: rewire claude/client.ts onto it
- 2026-08-03T21:20:46.646Z - task-done: T7: llm-stream tests incl. chunk boundaries
- 2026-08-03T21:20:46.738Z - task-done: T8: reader loops against the fake network
- 2026-08-03T21:20:46.824Z - task-done: T9: full gate
- 2026-08-03T21:20:46.912Z - ac-confirmed: AC1: takeLines, readSseLine, parseOpenAiChunk, parseOllamaLine, ReasoningFilter, isRetryable, retryDelay, selectProvider
- 2026-08-03T21:20:46.999Z - ac-confirmed: AC2: client.ts imports all of them; no phase/pending state machine, no inline SSE parsing, no duplicated retry predicate
- 2026-08-03T21:20:47.086Z - ac-confirmed: AC3: opening tag split, closing tag split, <b>bold</b> not mistaken, short reply flushed, unterminated block discarded
- 2026-08-03T21:20:47.174Z - ac-confirmed: AC4: 429 and rate and 5xx retried; 401/400/model-not-found not; word-bounded so 4500 tokens and id 1500123 are not statuses
- 2026-08-03T21:20:47.259Z - ac-confirmed: AC5: parseOpenAiChunk returns null on unparseable; the loop continues and the answer survives
- 2026-08-03T21:20:47.345Z - ac-confirmed: AC6: twelve tests drive openaiStream, ollamaStream and openaiGenerate against a fake network
- 2026-08-03T21:20:47.433Z - ac-confirmed: AC7: tag split across reads hidden; a reply too short to resolve the ambiguity still delivered
- 2026-08-03T21:20:47.519Z - ac-confirmed: AC8: typecheck clean, lint 0 errors, 930 tests, dupes 1, claude/client.ts 37.30% lines

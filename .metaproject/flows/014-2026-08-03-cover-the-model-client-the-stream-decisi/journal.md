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

## Review: four findings, and one of them was my own test lying

**The UTF-8 boundary test split nothing.** It took the last two bytes of the
line — `}` and `\n`, both ASCII — so it proved the decoder handles a split that
never happened. It would have passed with the streaming decoder removed
entirely. The split point is now found by locating the ellipsis in the byte
array, and mutation-checked: replacing `decode(value, { stream: true })` with
`decode(value)` fails it.

This is the third time in this programme that a test I wrote could not fail.
The pattern each time is the same — the test exercises the shape of the case
rather than the case.

**CRLF ended the stream nowhere.** SSE is specified with CRLF and several
providers send it; splitting on `\n` alone leaves `\r` on every line, so the
terminator arrives as `[DONE]\r`, which is not the terminator. The reader then
carries on emitting whatever follows the end of the stream. Pre-existing, and
now both fixed and covered end to end.

**The fake network accepted anything.** `serve()` ignored its match argument and
swallowed the recorder's errors, so the suite would have passed with a wrong
URL, a wrong method, or a system prompt that never reached the model. It asserts
the endpoint, the method, the streaming flag and both messages now — and the
Ollama case asserts `think: false`, which is the request that makes the
reasoning filter a fallback rather than the plan.

**The retry loop was never run.** The predicate and the backoff were tested; the
loop that consults them was not. `withRetry` takes its sleep as a parameter now,
defaulting to the real wait, so a test can watch it retry a 503 twice and
succeed, refuse to retry a 401, and give up after the budget on a persistent 429.

### An acknowledged behaviour change

The retry predicate is not a byte-for-byte extraction. It matches `rate`
case-insensitively where the original was case-sensitive, and it requires a
standalone three-digit 5xx where the original matched `5\d\d` anywhere — so a
context length of 4500 or a request id of 1500123 no longer reads as a server
error. Both are deliberate tightenings and neither affects the current call
sites, but they are changes and are recorded as such rather than described as a
move.

Tests 930 → 935.

The second round found the same finding still open: the helper programmed `""`,
which `FakeFetch` matches against every URL — so the fixture's unmatched-request
guard could never fire and a call to the wrong endpoint would have been answered
rather than reported. It requires the endpoint now, and the guard was checked by
pointing it at a wrong one: nine of sixteen tests fail.
- 2026-08-03T21:38:08.282Z - task-done: T1: Collect remaining context
- 2026-08-03T21:38:08.433Z - task-done: T2: Implement per plan
- 2026-08-03T21:38:08.613Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T21:38:08.800Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T21:38:08.972Z - task-done: T5: utils/llm-stream.ts — the decisions
- 2026-08-03T21:38:09.208Z - task-done: T6: rewire claude/client.ts onto it
- 2026-08-03T21:38:09.436Z - task-done: T7: llm-stream tests incl. chunk boundaries
- 2026-08-03T21:38:09.596Z - task-done: T8: reader loops against the fake network
- 2026-08-03T21:38:09.762Z - task-done: T9: full gate
- 2026-08-03T21:38:09.985Z - ac-confirmed: AC5: parseOpenAiChunk returns null on unparseable; asserted end to end with a truncated chunk mid-stream
- 2026-08-03T21:38:10.262Z - ac-confirmed: AC6: sixteen tests drive the loops; the helper requires the endpoint and the guard was checked by pointing it at a wrong one
- 2026-08-03T21:38:10.465Z - ac-confirmed: AC8: typecheck clean, lint 0 errors, 935 tests, dupes 1, claude/client.ts 40.31% lines
- 2026-08-04T20:45:19.213Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/50 (warning: PR is not a draft)
- 2026-08-04T20:45:19.313Z - completing
- 2026-08-04T20:45:21.055Z - done: all gates passed

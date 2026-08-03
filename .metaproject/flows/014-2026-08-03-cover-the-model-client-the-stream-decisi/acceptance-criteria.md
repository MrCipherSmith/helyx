# Acceptance Criteria

## Criteria

- AC1: `utils/llm-stream.ts` exports the line splitter, SSE line reader, both chunk parsers, the reasoning filter, the retry predicate and delay, and provider selection.
- AC2: `claude/client.ts` uses them; no copy of any of those decisions remains in it.
- AC3: The reasoning filter is asserted with the opening tag split across chunks, the closing tag split across chunks, an answer that merely starts with a tag, a reply shorter than the tag, and an unterminated block.
- AC4: The retry predicate retries 429 and 5xx and nothing else, and does not read a token count or an id as a status.
- AC5: A chunk that fails to parse costs that chunk, not the answer.
- AC6: The reader loops are driven against a fake network: deltas assembled, an event split across reads, a multi-byte character split mid-glyph, keep-alives ignored, usage captured, and a rejected request raised as an error.
- AC7: The Ollama loop hides a reasoning block whose tag is split across reads, and still delivers a reply too short to resolve the ambiguity.
- AC8: `bun run typecheck`, `bun run lint`, `bun test` pass; `bun run dupes` still 1; `claude/client.ts` line coverage above 35%, up from 6.17%.

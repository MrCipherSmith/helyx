# Cover the model client

Status: formalized

## Problem

`claude/client.ts` is 534 lines at 6% coverage. Three decisions live inside its
`while (true)` reader loops, and all three are about reading a stream: which
lines of an SSE body carry data, what a chunk means, and whether the text so far
is still inside a reasoning block that must not be shown.

Every one of them is hardest exactly at a chunk boundary — and a boundary is the
one thing a live model will not reproduce on request. A model does not send
`<think>` as a token; it sends `<`, then `th`, then `ink>`. The reasoning filter
already carries a comment about a previous version that swallowed whole answers
from models emitting no block at all. That bug was found in production, because
there was no other way to find it.

## Expected Outcome

`utils/llm-stream.ts` holds the decisions: line splitting that keeps the
incomplete tail, SSE line classification, chunk parsing for both protocols, the
reasoning-block state machine, the retry predicate and its backoff, and provider
selection. `claude/client.ts` uses them rather than carrying its own copies.

Then the loops themselves, driven end to end against the fake fetch from flow
011: a body arriving in chosen pieces, an event split across two reads, a
multi-byte character split mid-glyph, keep-alives, a malformed chunk, usage on
the final chunk, and a rejected request.

## Out of Scope

- The Anthropic SDK path. It is the SDK's own streaming, not a loop in this file.
- `summarizeConversation` and the session-facing wrappers.

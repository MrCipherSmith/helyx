# Code Review — PR #99

Version: 1.0.0
Reviewed: 2026-08-07, commit `0bbdc75` on `flow/055-ollama-custom-provider`

Five defects found and fixed on the branch. Four of them were silent: none
raises an error, and each produces output that looks like a model behaving
badly rather than a proxy behaving badly.

## R1 — a fresh `TextDecoder` per chunk mangles multi-byte characters (high)

`handleMessages` decoded each read with `new TextDecoder().decode(value, {stream: true})`.
The `stream: true` flag exists so a decoder can hold the tail of a character
that landed on a chunk boundary and finish it on the next read — a decoder
created per read throws that state away every time.

Invisible in English, where every character is one byte. The first Cyrillic
word that straddles a TCP packet comes out corrupted, and it would have been
reported as the local model producing garbage.

**Fixed:** one decoder for the life of the stream.

## R2 — an abandoned turn kept generating (medium)

The `ReadableStream` had no `cancel`. When Claude Code aborts a turn the
consumer goes away, but nothing cancelled the upstream reader, so Ollama carried
on to the end of its prediction with no reader.

On a CPU that is minutes of the machine's only inference slot, held for work
nobody wants — and `OLLAMA_NUM_PARALLEL=1` on this host means the next real
request waits behind it.

**Fixed:** `cancel()` cancels the upstream reader and says so in the log.

## R3 — `OLLAMA_URL` is written for the container, and this proxy is not in one (high)

`OLLAMA_URL` is the bot's setting. `.env.example` ships `http://ollama:11434`
(the compose service name) and `docker-compose.yml` overrides it to
`http://host.docker.internal:11434` for the container. Neither resolves on the
host — and the proxy is host-side by necessity, because Claude Code runs in tmux
there.

So a correct `.env` for the bot is a broken one for the proxy, on any host
installed from the example rather than this one. The symptom would be a
connection failure per request, naming a hostname the operator would then go
looking for.

**Fixed:** `hostReachableOllamaUrl()` rewrites container-only names to loopback
and leaves everything else — including a genuinely remote Ollama — as
configured. Error messages now report the resolved URL, not the raw setting.

## R4 — `/api/tags` on every single request (medium)

`pickModel()` called `availableModels()` per request, adding a round trip in
front of every turn to answer a question that changes only when someone runs
`ollama pull`.

**Fixed:** a 30-second TTL cache, which also holds its last good answer when
Ollama blips — model resolution should not change because of an outage the
request itself is about to report.

## R5 — `is_error` was dropped from tool results (medium)

Anthropic marks a failed tool call with `is_error: true`. Ollama's `tool`
message has no such field, and the flag was being discarded, so a failure whose
text does not happen to say "error" reached the model as a successful call that
returned that string. Exactly the class of failure this whole design is trying
to avoid: wrong, and quiet.

**Fixed:** the content is prefixed with `Error: ` when the flag is set.

## Also changed

`resetModelCaches()` is exported for tests. The caches are module state with a
time-based TTL; left in place, one test's model list answers the next test's
questions, and the failure looks like the code under test.

## What held

- Loopback binding, the enable gate, and the refusal to drift to another port.
- No path anywhere in the added code reads or writes Claude Code's own
  configuration — asserted, not assumed.
- The SSE event order, `stop_reason` mapping, and tool-call pairing all behave
  as the PRD specifies.
- NDJSON framing (`lastIndexOf("\n")`, remainder carried forward) is correct.
- A project with no provider selection is untouched: no existing provider file
  needed a change, and `tests/unit/resolve-provider-env.test.ts` is unmodified.

## Gate

`bun run typecheck` clean · `bun run lint` 0 errors · `bun test tests/unit/`
1977 pass, 0 fail.

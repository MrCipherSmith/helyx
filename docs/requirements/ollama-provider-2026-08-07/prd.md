# A Local Model Claude Code Can Actually Talk To — PRD

Version: 1.0.0

## 1. Problem

helyx can already put a project on a different backend. `/providers` registers
an Anthropic-compatible endpoint, `/projects → ⚙️` binds it to a path, and at
launch `scripts/resolve-provider-env.ts` turns that binding into three exports
consumed by `eval` in `scripts/run-cli.sh:58-60`. Four backends are registered
today; all four are cloud.

The one backend on the machine itself cannot be reached this way. Claude Code
speaks the Anthropic Messages API — `POST /v1/messages`, Anthropic's content
blocks, Anthropic's SSE. Ollama speaks its own `/api/chat` and an OpenAI-shaped
`/v1/chat/completions`. There is no Anthropic route on it. Pointing the `custom`
preset at `http://localhost:11434` produces a stream of 404s, not a fallback.

`bot/providers/presets.ts:75-78` already records this exact class of mistake for
OpenRouter — `/api` is the Anthropic route, `/api/v1` is the OpenAI one, and
choosing wrong "yields opaque request failures rather than a clear 'wrong
protocol' error". Ollama is the same trap with no correct URL to pick.

So the gap is not configuration. It is that nothing on this host translates.

## 2. What must not happen again

On 2026-08-07 `claude-code-router` was installed to fill exactly this gap. It
worked by writing `ANTHROPIC_BASE_URL` and an `apiKeyHelper` into the global
`~/.claude/settings.json`. Every session on the host inherited them; the proxy
was not running; nothing started. Details and the clean-up in
[README.md](README.md).

The failure was not that the router was buggy. It was that its unit of
configuration is the machine, while helyx's is the process. Two hard rules
follow, and they outrank every convenience in this document:

- **R1.** Nothing in this feature reads, writes, or requires a change to
  `~/.claude/settings.json`, `~/.claude.json`, or any shell profile.
- **R2.** A project that has not selected the local provider launches
  byte-identically to how it launches today. `resolveProviderEnv()` already has
  this property — it prints nothing when there is no selection
  (`scripts/resolve-provider-env.ts:77-105`) — and it keeps it.

## 3. The shape of the thing

A host-side daemon, in this repository, at `scripts/ollama-proxy.ts`.

It has to be host-side. The bot runs in Docker, but Claude Code runs in tmux on
the host and Ollama listens on the host's `11434`. A proxy in the container
would be reachable only through `host.docker.internal` in one direction and not
at all in the other. `admin-daemon` is already a host-side daemon started from
`cli.ts:1464-1478` behind a `pgrep` guard, logging to `/tmp` — the same shape,
for the same reason.

```
Claude Code ──Anthropic /v1/messages──▶ ollama-proxy ──/api/chat──▶ Ollama
 (tmux, host)      127.0.0.1:PORT       (bun, host)                 :11434
```

Selection goes through the existing path with no new mechanism: a row in
`providers` with `base_url = http://127.0.0.1:<port>`, bound to a project like
any other. `resolveProviderEnv()` then exports `ANTHROPIC_BASE_URL`,
`ANTHROPIC_MODEL`, clears both Anthropic credentials first — the security rule
documented at `scripts/resolve-provider-env.ts:33-45` — and sets
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, which this endpoint needs for the
same reason the cloud ones do.

`providers.auth_token` is `NOT NULL` (`memory/db.ts:805-813`). A loopback proxy
has nothing to authenticate, so the registration stores a placeholder and the
proxy ignores `Authorization` entirely. It listens on `127.0.0.1` only; that is
the whole of its access control, and binding to anything else is a defect.

## 4. The translation

This is where the work is. Each item below is a place where getting it wrong
produces silence or a lie rather than an error.

### 4.1 Request

| Anthropic | Ollama `/api/chat` | Note |
|---|---|---|
| `system` (string or block array) | leading `{role:"system"}` message | blocks are joined with `\n\n`; a dropped system prompt turns Claude Code into a model with no tools and no rules |
| `messages[].content` string | `content` | — |
| `content[] {type:"text"}` | `content` | multiple text blocks join with `\n\n` |
| `content[] {type:"tool_use", id, name, input}` | assistant `tool_calls[]` `{function:{name, arguments}}` | `id` has no Ollama counterpart — see 4.3 |
| `content[] {type:"tool_result", tool_use_id, content}` | `{role:"tool", content}` | order must be preserved; Ollama matches by position |
| `content[] {type:"image"}` | dropped | out of scope (§7); dropped with a logged warning, never silently |
| `tools[] {name, description, input_schema}` | `tools[] {type:"function", function:{name, description, parameters}}` | `input_schema` is already JSON Schema; it passes through as `parameters` |
| `tool_choice` | best-effort | Ollama has no equivalent; `{type:"none"}` omits `tools`, anything else passes them |
| `max_tokens` | `options.num_predict` | — |
| `temperature`, `top_p`, `stop_sequences` | `options.temperature`, `options.top_p`, `options.stop` | — |

**`options.num_ctx` is mandatory and is the highest-risk line in this document.**
Ollama does not default to the model's own context length; it defaults to a far
smaller window and silently truncates from the front. A Claude Code system
prompt plus tool definitions does not fit in that default, so the symptom is not
an error — it is a model that answers as if it had never been told the rules.
The proxy reads the real length once per model from `POST /api/show`
(`<family>.context_length`; 40 960 for `geekom-model-1`) and sends it explicitly.

### 4.2 Response and streaming

Claude Code streams. The proxy must emit Anthropic's event sequence, in order,
or the client hangs on a stream it cannot parse:

```
message_start
  content_block_start {index:0, content_block:{type:"text"}}
  content_block_delta  {delta:{type:"text_delta"}}         ×N
  content_block_stop
  content_block_start {index:1, content_block:{type:"tool_use", id, name}}
  content_block_delta  {delta:{type:"input_json_delta"}}   ×N
  content_block_stop
message_delta {delta:{stop_reason}, usage:{output_tokens}}
message_stop
```

- `stop_reason` is `tool_use` when the turn produced any `tool_call`, otherwise
  `end_turn`; `max_tokens` when Ollama reports the prediction limit. Claude Code
  drives its agent loop off this field — a turn with tool calls reported as
  `end_turn` ends the loop and looks like the model refusing to act.
- Ollama emits a tool call as one whole object, not as a token stream. The proxy
  therefore emits its `input_json_delta` as a single chunk. This is legal and
  simpler than faking incremental JSON.
- `usage.input_tokens` / `output_tokens` come from Ollama's
  `prompt_eval_count` / `eval_count`. They are the only usage this endpoint can
  report; cache fields are absent, and reporting invented ones would corrupt the
  context accounting that flow 054 is building on `message.usage`.
- The model advertises a `thinking` capability. Reasoning content must not be
  emitted as a text block — it is not an answer, and mixing it into `text`
  produces sessions where the visible reply is the model talking to itself.
  `think` is disabled on the request; anything that arrives regardless is
  dropped.

### 4.3 Tool-call identity

Anthropic pairs a `tool_use` with its `tool_result` by `id`. Ollama has no id
field and matches by message order. The proxy mints ids on the way out
(`toolu_<counter>` per request) and, on the way back, maps a `tool_result` to
its position by walking the conversation in order. When a `tool_use_id` cannot
be resolved, the request is rejected with an Anthropic-shaped `invalid_request_error`
rather than quietly dropping the result — a dropped result is a model that
answers as though the tool never ran.

### 4.4 The other routes

- `POST /v1/messages/count_tokens` — Claude Code calls it to size the context.
  Ollama has no tokeniser endpoint. The proxy answers with a character-based
  estimate and documents that it is an estimate. Answering 404 is worse: the
  client treats the failure as a request failure.
- `GET /health` — for `process_health` and for the operator.
- Anything else — an Anthropic-shaped 404 error body, so the message that
  reaches the terminal names the route.

### 4.5 Errors

Every failure — Ollama down, model not pulled, malformed body — is returned as
Anthropic's error envelope:

```json
{"type":"error","error":{"type":"api_error","message":"..."}}
```

with the message naming the cause. The failure mode this exists to prevent is
the one that started this whole flow: an operator seeing a session not start,
with nothing on screen saying why.

## 5. Lifecycle and visibility

- Started from `cli.ts` beside `ensureAdminDaemon()`, same `pgrep` guard, log at
  `/tmp/ollama-proxy.log`. It costs nothing when unused: it is an idle listener,
  and no project is bound to it by default.
- Heartbeats into `process_health` under the name `ollama-proxy`, so `/monitor`
  (`bot/commands/monitor.ts:34`) and the dashboard show it beside `admin-daemon`
  instead of an operator discovering it is down through a failed session.
- Port from `OLLAMA_PROXY_PORT`, default `3458`. Chosen away from `3456` so a
  leftover from the failed router attempt cannot be mistaken for this.
- If the port is taken, the daemon exits with a message naming what holds it.
  It does not pick another port: a provider row already points at this one.

## 6. Acceptance criteria

- **AC-1.** With no project bound to the local provider, `resolve-provider-env`
  prints nothing and a session launches exactly as before. Verified by the
  existing `tests/unit/resolve-provider-env.test.ts` staying green unmodified.
- **AC-2.** No file under `~/.claude/` is read or written by any code added in
  this flow. Verified by inspection of the diff and by a test asserting the
  proxy module references no such path.
- **AC-3.** A non-streaming `POST /v1/messages` carrying a system prompt, a
  two-turn history and one tool definition produces a valid Anthropic response
  body, and the corresponding Ollama request carries the system message, the
  tool in `function` form, and an explicit `options.num_ctx` equal to the
  model's own context length.
- **AC-4.** A streaming request emits the event sequence of §4.2 in order, with
  `stop_reason: "tool_use"` whenever the turn contains a tool call and
  `end_turn` when it does not.
- **AC-5.** A `tool_use` → `tool_result` round trip preserves the pairing: the
  result reaches Ollama in the right position, and an unresolvable
  `tool_use_id` yields an `invalid_request_error`, not a dropped block.
- **AC-6.** Ollama unreachable produces an Anthropic-shaped error naming the
  cause, with a non-2xx status — not a hang and not an empty 200.
- **AC-7.** `POST /v1/messages/count_tokens` returns a number for a
  well-formed body.
- **AC-8.** The daemon writes a `process_health` row named `ollama-proxy`, and
  `/monitor` renders it.
- **AC-9.** A port already in use makes the daemon exit non-zero with a message
  naming the port. It never binds a different one, and never binds beyond
  `127.0.0.1`.
- **AC-10.** `bun run lint`, `bun run typecheck` and `bun test tests/unit/` pass.

Live end-to-end use against the real model is the operator's own verification
step after the PR is reviewed, not an automated criterion — it depends on a
model being pulled and takes minutes per turn at this hardware's token rate.

## 7. Out of scope

- Images, PDFs, and any non-text content block.
- Prompt caching, `cache_control`, and the `usage` cache fields.
- Server-side tools (web search, computer use, code execution).
- Auth on the proxy. It is loopback-only; adding a token would be theatre.
- Making the local model the default for anything, or for daily work. At
  roughly 3–5 tokens/second on this host a single agent step takes minutes.
  This exists as an offline fallback and an experiment, and the PRD says so
  rather than letting the benchmark disappoint someone later.
- Any change to how the four cloud providers work.

## 8. Risks

| Risk | Why it matters | What this does about it |
|---|---|---|
| 40 960-token window vs Claude Code's system prompt and tool set | The prompt alone is a large fraction of it; long sessions will truncate | `num_ctx` set explicitly to the model's real maximum; §7 sets the expectation that this is not a daily driver |
| Tool-call fidelity under a 14B model | The agent loop is nothing but tool calls; a mis-shaped one stalls the session | Mapping is unit-tested in both directions (AC-3, AC-4, AC-5); the model's `tools` capability was verified before this was written |
| Streaming divergence from Anthropic's event order | Symptom is a client that hangs rather than errors | AC-4 pins the order; the sequence is asserted, not eyeballed |
| A second thing on the host that can be down | Another moving part between an operator and a working session | `process_health` + `/monitor`, and an error body that names the cause (AC-6, AC-8) |
| Scope creep back toward a general router | That is what broke the host the first time | R1/R2 in §2, and a proxy that serves exactly the routes in §4 |

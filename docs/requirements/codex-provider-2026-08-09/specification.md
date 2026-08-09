# Specification — Codex Provider for Claude Code

Version: 1.1.0

## Module Identity

- `scripts/codex-proxy.ts` — host-side Bun daemon, sibling to
  `scripts/ollama-proxy.ts`. Owns the sockets; no translation logic lives
  here.
- `utils/anthropic-codex.ts` — pure translation functions, sibling to
  `utils/anthropic-ollama.ts`. No I/O, unit-testable without a live Codex
  login, same as the Ollama translator's own test suite.
- `utils/codex-proxy-settings.ts` — enable flag and port, sibling to
  `utils/ollama-proxy-settings.ts`.

### Shared code, not a fork

`AnthropicRequest`, `AnthropicMessage`, `AnthropicBlock`, `AnthropicTool`,
`TranslationError`, `errorBody`, `serializeSse`, `SseEvent`, and
`AnthropicStream`'s event-shape logic in `utils/anthropic-ollama.ts` are
Anthropic-protocol code, not Ollama-specific. This package should move them
to a new `utils/anthropic-protocol.ts` that both `anthropic-ollama.ts` and
`anthropic-codex.ts` import, rather than copy-pasting a second copy of the
Anthropic side. `anthropic-ollama.ts` keeps only what is genuinely
Ollama-specific (`toOllamaRequest`, `toAnthropicResponse`'s Ollama-chunk
input, `resolveModel`, `toModelsResponse`). This refactor is in scope for
this package's implementation, not deferred — the two proxies sharing wire
types is what "maximally reuse what we already have" means concretely.

## Two designs, decided by the Phase 0 spike (`prd.md` §Recommendation, [spike-findings.md](spike-findings.md))

**Spike outcome (2026-08-09): Option B is ruled out. Option A is the only
remaining design**, kept below unchanged from before the spike as the
concrete target if the operator decides to build it — nothing past the
spike itself has been implemented.

### Option A — Codex as a delegated sub-agent (the design left standing)

- `codex-proxy.ts` receives an Anthropic request, renders it to a single
  prompt (system + conversation, flattened — same shape problem
  `flattenSystem()` in `anthropic-ollama.ts` already solves), and runs
  `codex exec -s workspace-write --json -o <tmpfile> <prompt>` with the
  project directory as `--cd`.
  - Sandbox mode is `workspace-write`, not `read-only`, in this option:
    Codex is the one editing files for the turn, on purpose — that is what
    "delegated" means here.
- The daemon does **not** attempt to translate individual tool calls. It
  waits for the run to finish, reads `<tmpfile>`, and returns one
  Anthropic `text` content block containing Codex's final message, with
  `stop_reason: "end_turn"`.
- Claude Code's own tool loop never fires for this turn — there is nothing
  for it to call, because Codex already did the work. The operator-visible
  difference from a normal Claude Code turn is real and should not be
  hidden: this design note itself, and the daemon's own log line for every
  request, should say "delegated to Codex" plainly.
- Streaming: still framed as an SSE stream (`AnthropicStream`-shaped) for
  client compatibility, but with a single content block emitted once
  `codex exec` exits — there is no incremental token stream to relay,
  since `codex exec` is not asked to stream.

### Option B — Codex as a tool-decision source (ruled out by the spike)

**Not viable — kept here only as a record of what was considered and why
it was rejected; see [spike-findings.md](spike-findings.md) for the
evidence.** Would have required reading tool-call intent from the `--json`
stream before Codex's sandbox executes it:

- Same request shape as Option A, but `-s read-only` and `--json` parsed
  incrementally: each JSONL event that represents "Codex wants to call
  tool X with arguments Y" is translated into an Anthropic `tool_use`
  block and the turn ends there (`stop_reason: "tool_use"`), exactly the
  point `AnthropicStream` in `anthropic-ollama.ts` already handles for
  Ollama's `tool_calls`. Claude Code executes the tool itself and sends
  back a `tool_result` on the next call.
- The daemon must track the Codex session id from the first call
  (`--json` reports it) and use `codex exec resume <id> --json
  <next-input>` for subsequent turns in the same conversation, instead of
  replaying the full history the way the Ollama translator does — Codex
  holds its own session state, and resending a whole transcript as a fresh
  prompt each turn would fight that rather than use it.
- This is the design that actually satisfies FR5. Do not attempt it until
  the spike confirms the event stream supports it — that confirmation is
  exactly what distinguishes this from Option A.

## Storage — reuse, no schema change

`providers` table (`memory/db.ts`, migration 46) already fits:

| Column | Value for the Codex row |
|---|---|
| `name` | `"Codex (OpenAI)"` |
| `base_url` | `http://127.0.0.1:<codex-proxy-port>` |
| `auth_token` | a placeholder string; the daemon does not read it — real auth is the host's own `codex` OAuth session, the same way `ollama-proxy.ts` ignores the token `resolve-provider-env.ts` still exports |
| `auth_scheme` | `"bearer"` |
| `models` | Codex model ids the operator's subscription actually grants — checked against a live account (R5 in `prd.md`), not copied from `CODEX_MODEL`'s stale `"o3"` default |

`bot/providers/presets.ts` gains a `codex` preset entry (`key: "codex"`,
`baseUrl` pointing at the local proxy port, `tokenHint` explaining the
token field is unused because login already happened via `/codex_setup`) —
same shape as the existing `glm`/`kimi`/`deepseek`/`openrouter` entries.

## Config surface

`utils/codex-proxy-settings.ts`, mirroring `utils/ollama-proxy-settings.ts`
exactly:

```ts
export const DEFAULT_CODEX_PROXY_PORT = 3459; // not 3456 (burned) or 3458 (ollama-proxy)
export function codexProxyEnabled(raw: string | undefined): boolean { /* same TRUTHY check */ }
export function codexProxyPort(raw: string | undefined): number { /* same clamp-and-fallback */ }
```

`CODEX_PROXY_ENABLED` (default off — same off-by-default policy as
`OLLAMA_PROXY_ENABLED`) and `CODEX_PROXY_PORT` added to `config.ts`'s zod
schema alongside the existing Ollama entries.

## CLI surface

`cli.ts` gains `ensureCodexProxy()`, same shape as `ensureOllamaProxy()`
(`cli.ts:1565-1582`): pgrep guard against a second instance, `Bun.spawn`
with a log file, gated by `codexProxyEnabled(process.env.CODEX_PROXY_ENABLED)`,
called from the same startup/bounce path `ensureOllamaProxy()` is called
from. No new Telegram command — provider selection is the existing
`/providers` flow once the preset exists.

## Data contracts

- Inbound: Anthropic `POST /v1/messages`, same shape `anthropic-ollama.ts`
  already types (post-refactor, imported from `anthropic-protocol.ts`).
- Outbound to Codex: an argv for `Bun.spawn` (not an HTTP body — the
  "backend" here is a subprocess, not a socket), built by a
  `toCodexArgv()` translator that is `anthropic-codex.ts`'s equivalent of
  `toOllamaRequest()`.
- Codex → Anthropic: `--json` events, or the `--output-last-message` file
  in Option A, parsed by a `toAnthropicResponse()`/`AnthropicStream`
  translator equivalent — reusing the shared streaming state-machine
  approach from `anthropic-ollama.ts`'s `AnthropicStream`, not a
  from-scratch implementation.
- Errors: `classifyCodexFailure()` from `services/reviewer-service.ts`,
  imported and called on a failed or empty Codex run, mapped to
  `TranslationError` the same way `anthropic-ollama.ts` maps Ollama's
  in-stream `error` field.

## Integration Points

- `bot/commands/codex.ts` (`/codex_setup`, `/codex_status`) — auth source
  of truth, unchanged and not duplicated.
- `services/reviewer-service.ts` (`classifyCodexFailure`, `codexArgv`
  pattern) — reused for error classification and as the argv-building
  precedent.
- `process_health` (`memory/db.ts`) — `codex-proxy.ts` heartbeats the same
  way `ollama-proxy.ts` does, so `/monitor` (`bot/commands/monitor.ts`)
  reports it without a special case.
- `scripts/resolve-provider-env.ts`, `scripts/run-cli.sh` — **unchanged**.
  This is the design's central property: a project pointed at this
  provider still launches `claude`, through the exact same env-injection
  path every other provider uses.

## Acceptance Criteria

- **AC1** — A project with `provider_id` pointing at the Codex provider
  row launches `claude` with a zero-line diff to `run-cli.sh`'s own
  behaviour; only the resolved `ANTHROPIC_BASE_URL` differs.
- **AC2** — ~~The Phase 0 spike (`prd.md` §Recommendation) is run and its
  answer is recorded~~ **Done, 2026-08-09** — see
  [spike-findings.md](spike-findings.md). Outcome: Option B ruled out,
  Option A is the only design left to build if the operator chooses to.
- **AC3** — `codex-proxy.ts` binds `127.0.0.1` only; a diff review confirms
  no write to `~/.claude/settings.json` or any path under `~/.claude/`,
  matching `docs/requirements/ollama-provider-2026-08-07/code-review.md`'s
  own check for its sibling.
- **AC4** — A live test against an exhausted or logged-out Codex account
  surfaces to the operator as a named condition (limit / auth), not a bare
  connection error — exercising `classifyCodexFailure()` end to end
  through the proxy, not just in its existing unit tests.
- **AC5** — `CODEX_PROXY_ENABLED` unset means nothing starts — verified the
  same way `tests/unit/ollama-proxy.test.ts` asserts the gate line exists
  in `cli.ts`.
- **AC6** — `utils/anthropic-codex.ts`'s translation functions have a unit
  test suite that runs without a live Codex login, mirroring
  `anthropic-ollama.ts`'s own tests.
- **AC7** — The shared-types refactor (`utils/anthropic-protocol.ts`) lands
  with `anthropic-ollama.ts`'s existing test suite still passing unchanged
  — proof the extraction did not alter Ollama's behaviour.

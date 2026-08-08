# PRD Review — Against The Code

Version: 1.0.0
Reviewed: 2026-08-07, `prd.md` v1.0.0 at commit `1100e7b`

Every factual claim the PRD makes about existing code was checked against the
file it cites. This document records what held, what did not, and what the
design would have hit during implementation.

## 1. Citations verified

| PRD claim | Verdict |
|---|---|
| `bot/providers/presets.ts:87-94` — a `custom` preset with empty base URL and `models: []` | ✅ true (`key: "custom"` at :88, `models: []` at :92) |
| `scripts/resolve-provider-env.ts:46-75` — `resolveProviderEnv()` builds the export lines | ✅ true |
| `scripts/resolve-provider-env.ts:33-45` — clearing both Anthropic credentials is the documented security rule | ✅ true, and the order is enforced at :55-57 |
| `scripts/resolve-provider-env.ts:77-105` — prints nothing without a selection | ✅ true; also swallows DB failure and exits 0 (:99-104) |
| `scripts/run-cli.sh:58-60` — the helper's output is `eval`'d | ✅ true |
| `bot/providers/presets.ts:75-78` — the `/api` vs `/api/v1` trap is already documented | ✅ true |
| `cli.ts:1464-1478` — `ensureAdminDaemon()`, `pgrep` guard, `/tmp` log | ✅ true |
| `memory/db.ts:805-813` — `providers`, `auth_token TEXT NOT NULL` | ✅ true |
| `memory/db.ts:452-467` — `process_health(name, status, detail, updated_at)` | ✅ true |
| `bot/commands/monitor.ts:34` — reads `process_health` | ✅ true |
| `tests/unit/resolve-provider-env.test.ts` exists | ✅ true |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` is already set for third-party base URLs | ✅ true (`scripts/resolve-provider-env.ts:67`) |

No citation was stale or wrong.

## 2. Findings

### F1 — `GET /v1/models` is missing, and it is on the only registration path (high)

The PRD's route list (§4.4) serves `/v1/messages`, `/v1/messages/count_tokens`,
`/health`, and 404s everything else. But registering a provider goes through
`/providers → ➕ Add → Custom`, and that flow calls `fetchProviderModels()`
(`bot/commands/providers.ts:176`), which probes four URLs
(`services/provider-service.ts:264-274`):

```
{base}/v1/models   {base}/models   {bareRoot}/v1/models   {bareRoot}/models
```

Against the PRD's proxy all four 404. The flow then falls back to
`preset.models`, and for `custom` that list is empty
(`bot/providers/presets.ts:92`), so the operator is dropped into
`"Models, comma-separated (or \"none\"):"` and has to type model names by hand —
for the one provider where the host knows the exact answer.

Serving `GET /v1/models` costs one call to Ollama's `/api/tags`. The response
must be `{"data":[{"id":…,"display_name":…}]}` — that is what
`parseModelsResponse()` accepts (`services/provider-service.ts:205-219`); any
other shape returns `null` and is treated as unreachable.

**Resolution: added to the PRD as a required route.**

### F2 — an unknown model name must not be an error (high)

`resolveProviderEnv()` exports exactly one model variable, `ANTHROPIC_MODEL`
(`scripts/resolve-provider-env.ts:72`). Claude Code does not send that name on
every request: background work — title generation, quick classifications — goes
to a small/fast model whose id it chooses itself when nothing overrides it. A
proxy that resolves the model strictly will answer those requests with an error
for a model Ollama has never heard of, and the visible symptom is a session that
mostly works with parts of it inexplicably failing.

The PRD did not mention model resolution at all.

**Resolution: added — any model the local Ollama does not have falls back to the
configured default, and the substitution is logged once per distinct name.**

### F3 — the daemon starts on every host, used or not (medium)

§5 put the start beside `ensureAdminDaemon()`, which runs at `cli.ts:1533` and
`cli.ts:1581` — i.e. on every `helyx up` and every bounce, on every host. On a
host where no project is bound to the local provider that is a new listener, a
new `process_health` row and a new thing that can be reported as down, in
exchange for nothing.

This cuts against the flow's own premise: the previous attempt broke the machine
precisely by making a local experiment global.

**Resolution: gated on `OLLAMA_PROXY_ENABLED`, default off. Enabled, it starts
with the stack; disabled, not one line of new behaviour runs.**

### F4 — AC-2 was broader than the code allows (low, precision)

AC-2 said no file under `~/.claude/` is read or written. Repo-wide that is
false: `services/provider-service.ts:308` reads
`${HOST_CLAUDE_CONFIG}/.credentials.json` to authenticate the default endpoint,
and that is correct, long-standing behaviour. The AC means *code added or
modified by this flow*, and a reviewer checking it literally would have found a
contradiction.

**Resolution: AC-2 reworded to scope it to the diff.**

### F5 — `num_ctx` claim confirmed, and now has evidence (informational)

The PRD's highest-risk line — that Ollama will not use the model's own context
length unless asked — was checked rather than assumed:

- `POST /api/show` on `geekom-model-1` reports `qwen3.context_length = 40960`,
  and its `parameters` block declares only `stop`, `temperature`, `top_k`,
  `top_p`, `repeat_penalty`. **No `num_ctx`.**
- The host's `ollama.service` sets `OLLAMA_HOST`, `OLLAMA_KEEP_ALIVE`,
  `OLLAMA_NUM_THREAD`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_NUM_PARALLEL` —
  **no `OLLAMA_CONTEXT_LENGTH`.**

So nothing on this host supplies the window, and the server default — not
40 960 — is what a request gets unless the proxy sends `options.num_ctx`. The
claim stands, with the evidence recorded rather than asserted.

### F6 — port 3458 is free (informational)

Checked against the host's listeners. `3457` is held by a `next-server`; `3458`
is unbound. AC-9 already requires exiting rather than drifting to another port,
which is the property that matters given a `providers` row hardcodes it.

## 3. What the design does not break

- **The existing provider flow** is untouched: the proxy is an ordinary
  `providers` row, so `/providers`, `/projects → ⚙️`, `resolveProviderEnv()` and
  `run-cli.sh` need no changes at all. This was the main thing to check, and it
  holds.
- **Projects with no selection** keep launching identically — `resolveProviderEnv()`
  returns an empty array for an empty row, and the helper prints nothing.
- **`auth_token NOT NULL`** is satisfied by storing a placeholder; nothing reads
  it back for a loopback endpoint, and `providerAuthHeaders()` sending a bearer
  header the proxy ignores is harmless.
- **`tests/unit/stack-recovery.test.ts`** constructs its own `process_health`
  rows, so a new `ollama-proxy` row does not disturb it.

## 4. Verdict

Approved with F1–F4 folded into `prd.md` v1.1.0. The specification is grounded —
all twelve code citations verified — and the two substantive gaps (model list,
model fallback) were gaps of omission rather than design errors: neither changes
the shape of the thing being built.

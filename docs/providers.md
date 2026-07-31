# LLM providers per project

Helyx can point any project at an Anthropic-compatible endpoint instead of
Anthropic itself, and can switch a running project over without losing its forum
topic or history. A project with nothing configured behaves exactly as it did
before this feature existed.

## For operators

### Register a provider

`/providers` → **➕ Add provider** → pick a preset (GLM, Kimi, DeepSeek,
OpenRouter) or **Custom**.

The flow asks for a base URL (prefilled for presets), a token, and a model list.
Answer `ok` at the model prompt to accept the preset's suggestions, `none` for
an empty list, or type your own comma-separated ids.

> The token reaches Telegram's servers in plaintext. Delete your message after
> sending it — helyx cannot do that for you.

### Choose a provider for a project

From `/projects`, each row has a **⚙️** button: provider picker → model picker.
Selecting a model applies the change and restarts the project. The confirmation
names what it came back on.

Newly added projects get the same picker at the end of `/project_add`, but only
when at least one provider is registered.

"Default (Claude)" is always the first option and means the Anthropic endpoint
with helyx's own key. Picking a model under it is a plain Anthropic tier switch.

### Removing a provider

Projects using it fall back to the default endpoint — they are not deleted and
do not break. They keep running on the old endpoint until their next restart.
The removal message lists which projects were affected.

### When a project restart-loops

A project on a custom provider that restarts repeatedly is usually a bad or
expired token: the endpoint rejects auth, claude exits, the wrapper retries
until the escalation limit stops it. The escalation message names the provider
and points at `/providers`.

## What can actually be plugged in

The only requirement is that the endpoint speaks the **Anthropic Messages API**.
Claude Code remains the agent runtime — helyx only tells it where to send
requests, so anything that does not speak that protocol will not work no matter
how it is configured.

| Backend | Works | Note |
|---------|-------|------|
| Anthropic | yes | the default; no provider needed |
| GLM (Z.ai) | yes | Anthropic-compatible endpoint |
| Kimi / Moonshot | yes | Anthropic-compatible endpoint |
| DeepSeek | yes | Anthropic-compatible endpoint |
| OpenRouter | yes | **use `https://openrouter.ai/api`, not `/api/v1`** — the versioned path is their OpenAI-compatible route and Claude Code cannot speak to it |
| OpenAI directly | **no** | Chat Completions is a different protocol; needs a translating proxy (LiteLLM, claude-code-router) registered as a Custom provider |
| Any local server | only if it exposes Anthropic Messages | Ollama's native API does not; a translating front-end does |

For anything in the "no" column the pattern is the same: run a proxy that
translates to the Anthropic Messages API, then register the proxy's URL as a
Custom provider. helyx does not care what is behind it.

## For developers

### Where the choice lives

`projects.provider_id` (FK to `providers`, `ON DELETE SET NULL`) and
`projects.model`. Both NULL is the default Anthropic path. `model` may be set
with `provider_id` NULL — an Anthropic tier switch.

`provider_id IS NULL` is deliberately *not* a sentinel row in `providers`. A
sentinel would mean a row with an empty base_url and empty token sitting in a
table where every other row is a real endpoint with a real secret, every
consumer special-casing it anyway, and a stray DELETE silently redefining
"default". The cost of the NULL representation is one synthetic
"Default (Claude)" entry in the picker.

### How it reaches the CLI

`scripts/run-cli.sh` calls `scripts/resolve-provider-env.ts` with the project
path, after loading the `.env` files and before launching claude. The helper
prints shell lines which the script `eval`s, and prints nothing at all when the
project has no selection.

A bun helper rather than psql inline in the shell buys three things: the project
path reaches SQL as a bound parameter instead of string interpolation, the
decision logic is a pure function with unit tests
(`tests/unit/resolve-provider-env.test.ts`), and it reuses the bot's connection
settings.

### ★ The key-leak rule

When a third-party `base_url` is resolved, `ANTHROPIC_API_KEY` **must be unset**
before the provider's own auth is exported.

helyx's `.env` sets `ANTHROPIC_API_KEY`, and `run-cli.sh` loads that file with
"only if unset" semantics — so a project `.env` *cannot* override it. Without an
explicit unset, the real Anthropic key would be sent to the third-party
endpoint. `ANTHROPIC_AUTH_TOKEN` is cleared alongside it so a value left over
from a previously-selected provider cannot survive a change of auth scheme.

This is enforced in `resolveProviderEnv()` and asserted by tests that check both
the presence of the unset and its ordering before any auth export. Do not
reorder those lines.

### What gets exported

| Variable | When |
|----------|------|
| `ANTHROPIC_BASE_URL` | a provider is selected |
| `ANTHROPIC_AUTH_TOKEN` | provider with `auth_scheme = bearer` |
| `ANTHROPIC_API_KEY` | provider with `auth_scheme = api_key` (after the unset) |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | a provider is selected — third-party endpoints reject the beta headers as opaque 400s |
| `ANTHROPIC_MODEL` | a model is selected, with or without a provider |

### Secret hygiene

`providers.auth_token` and the host process environment at launch are the only
places a token appears. It must never reach an `admin_commands` payload, a tmux
command argument, or a log line — which is why `run-cli.sh` echoes the resolved
base URL and model but never the evaluated block.

### Why a restart is required

Provider config is resolved at launch. A running session keeps its endpoint
until restarted, so the Telegram flow writes the row and then calls
`projectService.restart()`, which delegates to the idempotent `enqueueRestart`.
Identity is DB-backed, so the forum topic, history and `project_id` survive.

### Reserved for later

`sessions.cli_type` / `sessions.cli_config` are reserved for running a CLI other
than Claude Code. Nothing in this feature uses them.

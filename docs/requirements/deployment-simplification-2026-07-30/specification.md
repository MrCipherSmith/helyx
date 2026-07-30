# Specification: Deployment Simplification

Version: 1.0.4

## 1. Identity

| Field | Value |
|-------|-------|
| Package | `deployment-simplification-2026-07-30` |
| Kind | implementation-plan |
| Status | spec ready — all four open questions decided; nothing in this document is implemented |
| Surface | `install.sh`, `cli.ts`, `config.ts`, `Dockerfile`, `mcp/server.ts`, `.github/workflows/` |
| Evidence date | 2026-07-30 |

## 2. Measured Baseline

Everything in this table was measured on the running local stack and is the
reference point for the acceptance criteria in §8.

| Component | Measurement |
|-----------|-------------|
| `helyx-bot-1` | 77 MB RSS, 0.5% CPU at rest |
| `helyx-postgres-1` | 68 MB RSS, 0.5% CPU at rest |
| Database | 32 MB logical (`memories` 14 MB), 145 MB volume |
| `helyx-bot:latest` | 3.13 GB |
| `pgvector/pgvector:pg16` | 621 MB |
| `dashboard/` source | 246 MB |
| Claude CLI sessions | ~1.5 GB RSS for 10 idle sessions (~150 MB mean, 263 MB max) |
| `channel.ts` | 53 MB RSS |
| `scripts/admin-daemon.ts` | 67 MB RSS |
| Piper voices on disk | 233 MB |
| `node_modules` | 580 MB |
| Ollama models present | `gemma4:26b` 17 GB, `gemma4:e4b` 9.6 GB, `gemma4-coder` 7.4 GB, `nomic-embed-text` 274 MB |

The container stack is not the cost driver. Claude Code sessions on the host and
the image build are.

### 2.1 Estimates, not measurements

Three figures used throughout this package were **not** measured and must be
treated as working assumptions until verified:

| Figure | Where used | Basis |
|--------|-----------|-------|
| ~2 GB free memory to build the image | PRD P3, T5 rationale | Inference from `bun install` plus two dashboard builds; no build was profiled |
| ~12 GB to serve `gemma4:e4b` | PRD P2, preset table §5 | Inference from the 9.6 GB on-disk size |
| Preset RAM requirements (`tiny` ~2 GB, `small` ~4 GB) | §5 | Parameter-count heuristics, no benchmark |

The first is load-bearing: it is the stated reason a small server currently
fails, and therefore the justification for T5. It should be profiled before that
task is scheduled, not after.

## 3. Configuration Surface

`config.ts` declares a Zod `EnvSchema`; new variables are added there and
mirrored into the exported `CONFIG` object, matching existing style. No
`ENABLE_*` variable exists in the schema today.

### 3.1 New variables

| Variable | Type | Default | Purpose |
|----------|------|---------|---------|
| `ENABLE_DASHBOARD` | boolean-ish string | `true` when absent, `false` on fresh installs | Runtime dashboard gate (see R2/K1) |
| `HELYX_PROFILE` | enum `minimal` \| `local` \| `full` | `minimal` | Records the chosen profile for diagnostics and upgrades |

The asymmetric default for `ENABLE_DASHBOARD` is deliberate and is the mitigation
for risk K1: an existing `.env` that predates this work has no such variable and
must keep its dashboard, while a fresh install writes `ENABLE_DASHBOARD=false`
explicitly. "Absent" and "false" therefore mean different things, and the schema
must distinguish them rather than coercing both to the same value.

### 3.2 New Docker build argument

| Arg | Default | Effect |
|-----|---------|--------|
| `WITH_DASHBOARD` | `false` | When false, `dashboard-build` and `webapp-build` stages and their `COPY --from=` lines are skipped |

`Dockerfile` currently has three stages — `dashboard-build` (lines 5–9),
`webapp-build` (lines 11–16), `production` (lines 19–45). The production stage
takes build output at lines 34 and 37. Both the stages and those two `COPY`
lines are conditional on `WITH_DASHBOARD`.

## 4. Profile Contracts

A profile is a named bundle of defaults. It never introduces a setting that
cannot also be written by hand into `.env` (risk K3).

### 4.1 `minimal`

| Setting | Value |
|---------|-------|
| Inference | API provider chosen by the user |
| `EMBEDDING_MODEL` | unset — semantic memory search disabled |
| `SUMMARIZE_MODEL` | unset — summarization via the API provider |
| `TTS_PROVIDER` | `none`, or an API provider if a key is given |
| `ENABLE_DASHBOARD` | `false` |
| Piper voices | not downloaded |
| Host requirement | 2 GB RAM, 2 vCPU, 30 GB disk |

### 4.2 `local`

| Setting | Value |
|---------|-------|
| Inference | Ollama, lightweight preset (§5) |
| `EMBEDDING_MODEL` | `nomic-embed-text` (274 MB) |
| `SUMMARIZE_MODEL` | lightweight preset model |
| `TTS_PROVIDER` | `piper` |
| `ENABLE_DASHBOARD` | `false` — asked, defaulting to no (§4.4) |
| Piper voices | user-selected, downloaded at setup |
| Host requirement | 6 GB RAM, 4 vCPU, 40 GB disk |

### 4.3 `full`

Current behaviour preserved: dashboard on, heavy Ollama models permitted,
complete prompt set available. Host requirement 16 GB RAM, 4 vCPU, 80 GB disk.

### 4.4 Dashboard is a separate axis

The dashboard default is **off unless the profile is `full` or `--dashboard` is
passed**, and it is not tied to host size.

| Profile | Wizard question | Default |
|---------|-----------------|---------|
| `minimal` | not asked | `false` |
| `local` | asked | `false` |
| `full` | not asked | `true` |

`--dashboard` / `--no-dashboard` override in any profile.

The resource argument does not decide this. Once the image is published (T5) the
user builds nothing, and at runtime the dashboard costs almost nothing — no
separate process, just static files and routes on the HTTP server that already
serves MCP. Two other arguments do decide it:

**Orthogonality.** A profile answers "where does inference happen". How much web
interface the operator wants is an unrelated axis. Coupling them means someone
who chose local models for privacy silently receives a web UI.

**Exposure.** `docker-compose.yml` binds the port to `127.0.0.1`, but the
dashboard and the MCP endpoint share one HTTP server, and `webhook` transport
requires publishing that port through a tunnel. On any webhook deployment the
dashboard routes therefore become publicly reachable, protected only by
`dashboard/auth.ts`. That surface must be opted into, not inherited from a
profile choice about model hosting.

## 5. Model Presets

Preset identifiers are stable. The model each maps to is recorded here, but is a
maintenance decision that will drift as models are released; the binding
requirement is the memory rule, not the model name.

| Preset | Model | Download | Context | RAM to serve (est.) |
|--------|-------|----------|---------|---------------------|
| `tiny` | `qwen3:1.7b` | 1.4 GB | 40K | ~2.5 GB |
| `small` | `qwen3:4b` | 2.5 GB | 256K | ~4.5 GB |
| `heavy` | `gemma4:e4b` (current default) | 9.6 GB | — | ~12 GB |
| `embed` | `nomic-embed-text` | 274 MB | — | ~1 GB |

Download sizes are from the Ollama library and are measured. RAM figures remain
estimates — see §2.1.

### 5.1 Why Qwen3

The local model serves two consumers: standalone chat, and `SUMMARIZE_MODEL` for
conversation-history compaction. The second one drives the choice — summarization
runs over Russian text, and at the 1–4 B scale multilingual competence is the
scarce property, not raw capability.

That eliminates most of the field. Llama 3.2 at 1B/3B is weak in Russian.
SmolLM2 is English-oriented and its 8K context is too small to summarize a
conversation window.

Gemma 3 was the closest alternative and was rejected on specifics: `gemma3:4b`
is 3.3 GB against Qwen3-4B's 2.5 GB, carries half the context (128K vs 256K),
and is multimodal — it ships a vision tower this project never invokes.
`gemma3:1b` is genuinely small at 815 MB, but Gemma's 140-language claim applies
to the larger sizes, and the 1B variant is measurably weaker in Russian. It
remains the right fallback if a future deployment prioritises footprint over
Russian quality.

### 5.2 Reasoning-mode caveat

Qwen3 is a hybrid reasoning model and emits a `<think>` block before its answer
by default. For summarization this is not merely wasted tokens — unless the
block is suppressed or stripped, it lands inside the stored summary. T3 must
disable it explicitly, via the `/no_think` directive in the prompt or the
equivalent Ollama parameter, and must verify the stored summary is clean.

### 5.3 Selection rule

The wizard reads available memory — the cgroup limit when one is present,
otherwise the host total — and MUST NOT offer a preset whose requirement exceeds
it. When no chat preset fits, it states this plainly and falls back to the API
path. A precheck that cannot determine memory warns and offers the API path; it
does not guess (risk K5).

## 5A. Piper Packaging

### 5A.1 Current state

Nothing Piper-related is in the image. `which piper` in the running container
returns nothing; everything arrives through the `./piper:/app/piper:ro` bind
mount declared in `docker-compose.yml`. The wizard downloads voices from
HuggingFace but never the runtime, so the engine has no automated install path
(PRD P5).

| Component | Size | Contents |
|-----------|------|----------|
| `piper/piper/` — runtime | 52 MB | piper binary, `libonnxruntime.so` (15.6 MB), espeak-ng + data, `libpiper_phonemize.so`, `libtashkeel_model.ort` (9.8 MB) |
| `piper/voices/` — voices | 181 MB | 3 voices at 60.3 MB each: `en_US-lessac-medium`, `ru_RU-dmitri-medium`, `ru_RU-irina-medium` |

The wizard offers six voices, so baking all of them would add roughly 360 MB of
voices alone.

### 5A.2 Decision: split runtime from voices

**The runtime is baked into the image.** 52 MB is tolerable even in `minimal`,
where TTS is off, and it closes P5: the engine is then built for the same
platform as the image, and the user has no other way to obtain it.

**Voices are not baked.** They are a per-user choice, downloaded at setup —
selected ones only — and kept on the host, so they survive image upgrades.
Someone who wants one Russian voice should not carry French and Spanish.

A separate `-piper` image variant was rejected: the dashboard flag already
produces two variants and this would make four, which is not worth 52 MB.

### 5A.3 Required mount change

`docker-compose.yml` currently mounts the whole directory:

```yaml
- ./piper:/app/piper:ro
```

That mount would shadow a baked runtime at the same path. It MUST be narrowed to
the voices subdirectory:

```yaml
- ./piper/voices:/app/piper/voices:ro
```

This failure mode is silent — the baked runtime simply disappears under the
mount, and nothing reports it until the first synthesis attempt.

### 5A.4 Voice source

HuggingFace is the only voice source and is unreachable from some regions. The
wizard MUST offer either a configurable mirror or a way to point at a
pre-populated voices directory, and MUST fail with a clear message rather than
leaving a half-configured TTS setup.

## 6. CLI Surface

### 6.1 `helyx setup` flags

Every flag maps to exactly one existing prompt. Supplying `--profile` makes the
run non-interactive; any required value still missing is a named error, never a
prompt.

| Flag | Values | Maps to |
|------|--------|---------|
| `--profile` | `minimal` \| `local` \| `full` | Profile choice (R1) |
| `--bot-token` | string | Telegram bot token prompt |
| `--allowed-users` | comma-separated IDs | Telegram user ID prompt |
| `--provider` | `anthropic` \| `google` \| `openrouter` \| `ollama` | LLM provider prompt |
| `--api-key` | string | Provider key prompt |
| `--dashboard` / `--no-dashboard` | — | `ENABLE_DASHBOARD` |
| `--transport` | `polling` \| `webhook` | Transport prompt |
| `--webhook-url`, `--webhook-secret` | string | Webhook prompts |
| `--tts` | existing `TTS_PROVIDER` enum | TTS prompt |
| `--model-preset` | `tiny` \| `small` \| `heavy` | Local model preset (§5) |
| `--yes` | — | Accept all remaining defaults |

Wizard helpers `ask` (`cli.ts:37`), `askChoice` (`cli.ts:44`) and
`askMultiCheck` (`cli.ts:58`) are the interception points: in unattended mode
they resolve from parsed flags instead of reading stdin. Command dispatch is the
`switch` at the foot of `cli.ts`, where `setup` is already registered.

### 6.2 `install.sh`

| Behaviour | Current | Target |
|-----------|---------|--------|
| Image source | Local `docker build` | Pull published image; `--build-local` to opt out |
| Wizard invocation | `exec helyx setup < /dev/tty` (line 134) | Same when interactive; direct exec with forwarded flags when any are present |
| Prerequisites | git, docker, bun, claude | Unchanged |

## 7. Integration Points

| Point | Location | Change |
|-------|----------|--------|
| Dashboard route gate | `mcp/server.ts:517`, `handleDashboardRequest` | Guard the call on `ENABLE_DASHBOARD`; the MCP `/mcp` route below it must be unaffected (risk K2) |
| Dashboard implementation | `mcp/dashboard-api.ts` — `DIST_DIR` line 17, `WEBAPP_DIST_DIR` line 18 | Must tolerate absent dist directories in a dashboard-off image without throwing at import time |
| Shared port | 3847 serves both MCP and dashboard | Unchanged; only dashboard routes disappear |
| Auth | `dashboard/auth.ts`, imported by `mcp/server.ts:16` | Unused when disabled; must not fail to import |
| CI publish | `.github/workflows/build.yml` | Add push of both variants; the workflow builds but does not push today |
| Piper runtime | `Dockerfile`, `docker-compose.yml` line 31 | Bake the 52 MB runtime into the image; narrow the bind mount to `./piper/voices` so it does not shadow it (§5A) |

## 8. Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| A1 | `ENABLE_DASHBOARD=false` yields 404 on dashboard routes | HTTP request against a running instance |
| A2 | `/mcp` endpoint works identically with the dashboard off | MCP session connects and lists tools |
| A3 | Absent `ENABLE_DASHBOARD` keeps the dashboard on | Start with a pre-existing `.env`; dashboard reachable |
| A4 | `WITH_DASHBOARD=false` image omits dashboard build stages | Build log shows stages skipped; image is smaller than the 3.13 GB baseline |
| A5 | Dashboard-on image behaves as today | Dashboard loads and authenticates |
| A6 | `minimal` profile asks ≤ 4 questions | Wizard transcript |
| A7 | Memory precheck hides presets that do not fit | Run with a constrained cgroup; heavy preset absent from the menu |
| A8 | Unattended setup completes with stdin closed | `setsid helyx setup --profile=minimal ... < /dev/null` exits 0 and writes `.env` |
| A9 | Missing required flag fails by name | Exit non-zero, message identifies the flag |
| A10 | `install.sh` completes without a local build | Run on a host with Docker only |
| A11 | Minimal deployment survives 24 h on 2 GB | No OOM; bot answers |
| A12 | Piper runtime present in the published image | `which piper` inside a container started from the published image |
| A13 | Narrowed mount does not shadow the runtime | Start with a host `piper/voices` directory; synthesis succeeds |
| A14 | Voice download failure is explicit | Block the HuggingFace host; setup reports it rather than half-configuring TTS |

## 9. Out of Scope

Session-level resource behaviour is untouched. Claude Code CLI sessions remain
the dominant memory consumer (~150 MB each at rest, higher under load), they run
on the host rather than in the container, and nothing in this package changes
that. Anyone sizing a host must budget for them separately from the figures in
§2.

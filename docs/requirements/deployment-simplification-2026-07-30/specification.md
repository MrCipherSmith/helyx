# Specification: Deployment Simplification

Version: 1.1.0

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
| `dashboard/` source | 246 MB on disk, but only 1.5 MB reaches the build context — `.dockerignore` excludes `dashboard/node_modules` |
| Claude CLI sessions | ~1.5 GB RSS for 10 idle sessions (~150 MB mean, 263 MB max) |
| `channel.ts` | 53 MB RSS |
| `scripts/admin-daemon.ts` | 67 MB RSS |
| `piper/` on disk | 233 MB total — 52 MB runtime + 181 MB voices; all of it reaches the image via `COPY . .` (§5A) |
| `node_modules` | 580 MB |
| Ollama models present | `gemma4:26b` 17 GB, `gemma4:e4b` 9.6 GB, `gemma4-coder` 7.4 GB, `nomic-embed-text` 274 MB |

The container stack is not the cost driver. Claude Code sessions on the host and
the image build are.

### 2.1 Build memory — measured 2026-07-30

The "~2 GB to build" figure this package was originally built on **was wrong by
at least 2×**, and the reason a small host struggles is not the one this package
assumed. Measured by confining a `docker-container` buildx builder to a hard
memory limit and 2 CPUs — the `minimal` target host — building `--no-cache`:

| Build | 2 GB | 1 GB | 512 MB | 256 MB |
|-------|------|------|--------|--------|
| Full (with dashboard) | pass, 72 s | pass, 75 s | **fail** — OOM ×2 | — |
| Dashboard stages removed | — | — | pass, 69 s | pass, 60 s |

Halving 2 GB → 1 GB cost three seconds. Reclaim events rose from 1 843 to 8 346,
but nothing was ever killed. The failure at 512 MB is precise: `bun run build`
in the `webapp-build` stage, `cannot allocate memory`.

**The dashboard build is the memory wall.** Removing those two stages drops the
floor from between 512 MB and 1 GB to at most 256 MB — a fourfold improvement,
and the strongest argument for T2 in this document.

Method caveat: the limit binds the builder container while the host underneath
has 28 GB, so reclaimable page cache is cheap. This measures the build's own
working set, not total host requirement — a real 2 GB VPS also carries dockerd
and the OS. The honest statement is *the build itself needs 1 GB free, or
256 MB with the dashboard stages off*.

### 2.2 Image composition — measured 2026-07-30

The assumption that the dashboard inflates the image is **false**. A
dashboard-free build produces 3.13 GB against the full build's 3.14 GB. The
compiled dashboard is 1.02 MB of `dist`; nothing else about it reaches the image
beyond its 1.5 MB of source inside `COPY . .`.

Where the 3.13 GB actually comes from:

| Layer | Size | Note |
|-------|------|------|
| `RUN mkdir -p … && chown -R bun /app …` | **905 MB** | `chown -R` rewrites every file it touches into a new layer — a duplicate of everything copied above it |
| `RUN bun install --production` | 492 MB | `node_modules` |
| `COPY . .` | 414 MB | build context; **233 MB of it is `piper/`** |
| `apt-get install git curl ca-certificates` | 144 MB | |
| `COPY dashboard/dist` + `webapp/dist` | 1.02 MB | the entire dashboard contribution |

The 905 MB `chown -R` layer is a plain Docker anti-pattern and is the single
largest item in the image. It was not a task when this package was written; it
is now T6.

Two estimates remain unmeasured and are lower-stakes: ~12 GB to serve
`gemma4:e4b` (PRD P2, §5) and the preset RAM figures in §5. Neither carries a
task's justification.

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

### 5A.1 Current state — corrected 2026-07-30

An earlier revision of this section claimed nothing Piper-related was in the
image. **That was wrong.** It rested on `which piper` returning nothing inside
the container, which only shows the binary is not on `PATH` — it never is, since
it is invoked by path from `PIPER_DIR=/app/piper`.

Inspecting the image directly, with no mounts: `/app/piper` contains 233 MB —
the complete runtime *and* all three voices. `COPY . .` copies the whole `piper/`
directory in, and the `./piper:/app/piper:ro` bind mount then shadows it at
runtime, which is why the baked copy is invisible from a running container.

So the runtime already ships, accidentally. Two real problems remain, and they
are not the one originally recorded:

1. Every image carries whichever voices the maintainer happened to have on disk
   — 181 MB of them — including for `minimal` deployments with TTS off.
2. The baking is incidental rather than declared: it survives only as long as
   `COPY . .` stays broad and `piper/` stays out of `.dockerignore`. Nothing
   states the intent, so a future context-narrowing change would silently remove
   local TTS from the image.

| Component | Size | Contents | In image today |
|-----------|------|----------|----------------|
| `piper/piper/` — runtime | 52 MB | piper binary, `libonnxruntime.so` (15.6 MB), espeak-ng + data, `libpiper_phonemize.so`, `libtashkeel_model.ort` (9.8 MB) | yes, via `COPY . .` |
| `piper/voices/` — voices | 181 MB | 3 voices at 60.3 MB each: `en_US-lessac-medium`, `ru_RU-dmitri-medium`, `ru_RU-irina-medium` | yes, via `COPY . .` |

The wizard offers six voices; a user who selected all of them would push this
past 360 MB, all of it shipped to every deployment.

### 5A.2 Decision: split runtime from voices

The decision is unchanged by the correction above — but it is now a matter of
making the split explicit and excluding voices, rather than adding a runtime
that was missing.

**The runtime stays in the image, deliberately.** 52 MB is tolerable even in
`minimal` where TTS is off, and it must be stated as intent (a dedicated `COPY`
of `piper/piper/`) rather than left to a broad `COPY . .`, so that narrowing the
build context later cannot silently break local TTS.

**Voices leave the image.** `piper/voices/` goes into `.dockerignore` — that
is 181 MB removed from every image, and it stops users inheriting the
maintainer's personal voice set. Voices become what they always should have
been: a per-user download at setup, kept on the host, surviving image upgrades.

A separate `-piper` image variant was rejected: the dashboard flag already
produces two variants and this would make four, which is not worth 52 MB.

### 5A.3 Required mount change

`docker-compose.yml` currently mounts the whole directory:

```yaml
- ./piper:/app/piper:ro
```

That mount already shadows the baked runtime — this is not a hypothetical, it is
the current state, and it is why the runtime appeared to be missing (§5A.1). It
MUST be narrowed to the voices subdirectory:

```yaml
- ./piper/voices:/app/piper/voices:ro
```

The failure mode is silent in both directions: the baked runtime disappears
under the mount with nothing reported, and on a host where `./piper` is empty or
absent, synthesis fails despite a perfectly good copy sitting in the image.

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
| A12 | Piper runtime present in the published image | `ls /app/piper/piper` in a container run from the image **with no mounts**. Not `which piper` — the binary is never on `PATH`, and that check is what produced the false finding corrected in §5A.1 |
| A13 | Narrowed mount does not shadow the runtime | Start with a host `piper/voices` directory; synthesis succeeds |
| A14 | Voice download failure is explicit | Block the HuggingFace host; setup reports it rather than half-configuring TTS |
| A15 | Voices excluded from the image | `/app/piper/voices` is absent or empty in a freshly built image; image is ~181 MB smaller than the 3.13 GB baseline |
| A16 | Dashboard-off build fits in 256 MB | Build under a 256 MB / 2 CPU builder; completes with no OOM kill (§2.1) |

## 9. Out of Scope

Session-level resource behaviour is untouched. Claude Code CLI sessions remain
the dominant memory consumer (~150 MB each at rest, higher under load), they run
on the host rather than in the container, and nothing in this package changes
that. Anyone sizing a host must budget for them separately from the figures in
§2.

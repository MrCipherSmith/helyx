# PRD: Deployment Simplification

Version: 1.1.0

## 1. Problem

Helyx already ships an interactive installer — `install.sh` checks
prerequisites, clones, installs the `helyx` CLI, and execs `helyx setup`, which
asks about deployment type, LLM provider, Ollama, Telegram transport, Groq, and
TTS. The wizard is not missing. What is missing is *restraint*: every heavy
component is on by default, and the wizard offers no way to say "give me the
small one".

Five concrete defects, all measured on 2026-07-30 against the running stack:

**P1 — The dashboard is mandatory, and it is what makes the build fail on a
small host.** There is no feature flag anywhere: a grep for `ENABLE`/`DISABLE`
across `config.ts` returns nothing. The dashboard is compiled into the image by
two dedicated Dockerfile stages (`dashboard-build`, `webapp-build`), each
running its own `bun install` plus `bun run build`. At runtime it is served from
the same HTTP server as MCP, unconditionally, at `mcp/server.ts:517`.

The cost is **memory, not size** — this was measured after the package was
drafted and corrects the original claim. The dashboard adds 1.02 MB to the
image, so a user who only wants a Telegram bot carries almost no extra bytes.
What they do carry is a build that needs four times the memory: it dies at
512 MB inside `bun run build`, and succeeds at 256 MB once those stages are
gone (specification §2.1).

**P2 — Local-model defaults are unusable on a small host.** The wizard's Ollama
path defaults to `gemma4:e4b` for both chat and summarization. That model is
9.6 GB on disk and needs roughly 12 GB of RAM to serve. The wizard offers it
without reading how much memory the host actually has. On a 2 GB VPS the
selection succeeds and the deployment then fails at first use.

**P3 — Building on the target host is the real memory ceiling.** The stack at
rest is tiny: `helyx-bot-1` holds 77 MB RSS at 0.5% CPU, `helyx-postgres-1`
holds 68 MB, and the database is 32 MB (145 MB volume). Runtime is not the
constraint — the image build is. `bun install` plus two dashboard builds needs
memory the runtime never needs, so the smallest viable server is dictated by a
step that only ever needs to happen once, anywhere.

**Measured 2026-07-30, and the original framing of this problem was wrong.**
The figure this package was written around — ~2 GB to build — is off by at least
2×: the full build completes in 1 GB with no OOM, three seconds slower than in
2 GB. It fails at 512 MB, and it fails precisely inside `bun run build` for the
dashboard webapp. With the two dashboard stages removed it builds in 256 MB.

So the build is a real constraint, but a much smaller one than claimed, and it
is *the dashboard build* that sets the floor — not `bun install`, and not the
build in general. Full numbers and method in specification §2.1.

**P4 — The installer cannot run unattended.** `install.sh:134` ends with
`exec helyx setup < /dev/tty`. There is no flag-driven path, so the installer
cannot be used from cloud-init, a Dockerfile, CI, or any provisioning tool.

**P5 — Piper ships by accident, voices and all.** An earlier revision of this
document stated that nothing Piper-related was in the image and that a published
image would have no working TTS. **That was wrong**, and the correction is
recorded in specification §5A.1: the check behind it — `which piper` inside the
container — only proves the binary is not on `PATH`, which it never is.

What is actually true: `COPY . .` copies the entire `piper/` directory into the
image, all 233 MB of it — runtime *and* every voice the maintainer had on disk.
The `./piper:/app/piper:ro` bind mount then shadows it at runtime, which is what
made the baked copy invisible.

The defect is therefore the opposite of the one first recorded. Nothing is
missing; too much is shipped, and none of it is intentional. Every deployment,
including `minimal` with TTS disabled, carries 181 MB of someone else's voices,
and the runtime's presence depends entirely on `COPY . .` staying broad — so any
future narrowing of the build context would remove local TTS silently.

## 2. Goal

A newcomer runs one command, answers three or four questions, and has a working
Helyx on a 2 GB / 2 vCPU VPS without building anything locally. An operator
provisions the same thing from a script with no terminal attached.

## 3. Users

| User | Need | Currently blocked by |
|------|------|----------------------|
| First-time self-hoster | Working Telegram bot, minimum cost, minimum decisions | P1, P2, P3 |
| Offline / privacy-driven operator | Everything local, no third-party API calls | P2 |
| Automation engineer | Reproducible provisioning from a script | P4 |
| Existing user (the maintainer) | Nothing regresses; dashboard and heavy models stay available | all — must remain opt-in-compatible |

## 4. Requirements

### R1 — Deployment profiles

The wizard MUST open with a single profile choice that determines every
downstream default, and MUST then ask only the questions that profile needs.

| Profile | Composition | Target host |
|---------|-------------|-------------|
| `minimal` | All inference via API. No Ollama, no Piper, dashboard off. | 2 GB / 2 vCPU / 30 GB |
| `local` | Ollama with lightweight models, Piper TTS, fully offline. | 6 GB / 4 vCPU / 40 GB |
| `full` | Current behaviour: dashboard on, heavy models permitted. | 16 GB / 4 vCPU / 80 GB |

The wizard MUST reduce from its present ~15 prompts to 3–4 in `minimal`.

### R2 — Dashboard feature flag

The dashboard MUST be disabled by default and gated at three layers. A runtime
flag alone is insufficient: it prevents route registration but leaves the build
steps in place, and those steps — not the image size — are what fails on a small
host (P1, specification §2.1).

| Layer | Mechanism | Effect when off |
|-------|-----------|-----------------|
| Build | Docker build argument | `dashboard-build` and `webapp-build` stages skipped |
| Runtime | Env var read through `EnvSchema` | `handleDashboardRequest` not invoked |
| Setup | Wizard question, default *no* | Flag written to `.env` |

Enabling the dashboard MUST leave its behaviour byte-for-byte unchanged.

### R3 — Lightweight model presets

Each profile MUST carry a named model preset rather than a free-text default.
Before offering any local-model option, the wizard MUST read available host
memory and MUST NOT present a preset whose requirement exceeds it; if no preset
fits, it MUST say so and fall back to the API path.

### R4 — Non-interactive install

`helyx setup` MUST accept flags covering every prompt and run to completion with
no controlling terminal. `install.sh` MUST forward those flags and skip the
`< /dev/tty` exec when they are present. Missing required values MUST fail with
a named error, never an interactive prompt.

### R5 — Prebuilt image

The image MUST be published to a public registry from CI, in a dashboard-off and
a dashboard-on variant. `install.sh` MUST default to pulling it. Building
locally MUST remain available behind an explicit flag.

Note: `.github/workflows/build.yml` today builds the image (`docker build -t
helyx .`) but never pushes it, so the publishing step is new work, not a
configuration change.

The published image MUST carry the Piper runtime deliberately rather than as a
side effect of `COPY . .` (P5), and MUST exclude `piper/voices`.

The measured build results (§2.1) weaken this requirement's original
justification and it must be restated honestly. Publishing was argued for as
*enabling* deployment on a small host — "otherwise it will not build". That is
no longer the claim: with the dashboard stages off (R2) a 256 MB builder
succeeds, so almost any host can build. What publishing actually buys is time,
the absence of a build toolchain, and not making a first-time user wait through
a build to find out whether it worked. Those are convenience arguments, and R5
should be prioritised as a convenience requirement.

## 5. Success Criteria

| # | Criterion | Measurement |
|---|-----------|-------------|
| S1 | Minimal profile runs on 2 GB RAM — bot and database only, excluding Claude Code sessions | Bot answers in Telegram; no OOM over 24 h |
| S2 | No local build required | Install completes on a host with Docker and no build toolchain |
| S3 | ~~Dashboard-off image materially smaller~~ — **withdrawn, measured false** | A dashboard-free build is 3.13 GB against 3.14 GB. The compiled dashboard is 1.02 MB. Replaced by S8 |
| S8 | Image materially smaller than the 3.13 GB baseline | Achieved by excluding `piper/voices` (~181 MB) and fixing the 905 MB `chown -R` layer, not by the dashboard flag. See specification §2.2 and T6 |
| S4 | Dashboard-off exposes no dashboard surface | Dashboard routes return 404; MCP endpoint unaffected |
| S5 | Minimal profile asks ≤ 4 questions | Prompt count in a wizard transcript |
| S6 | Unattended install works | `helyx setup` with flags succeeds under `setsid`, stdin closed |
| S7 | No regression when enabled | Dashboard-on deployment behaves as today |

S3 is deliberately expressed as a comparison rather than a target number: the
saving cannot be predicted from the 246 MB source tree alone, because build
output and layer sharing both differ from source size. It must be measured
after the build arg exists.

## 6. Risks

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| K1 | Existing `.env` files lack the new flags | Dashboard silently disappears on upgrade | Default the runtime flag to *on* when the variable is absent entirely; write it explicitly only for fresh installs |
| K2 | Dashboard is coupled to MCP more deeply than the single call site suggests | Gate breaks MCP | Verify the MCP endpoint independently before shipping; the gate must not sit in the shared request path |
| K3 | Profile abstraction hides a setting a user needs | Support burden | Keep every underlying env var writable by hand; profiles only choose defaults |
| K4 | Published images drift from the repo | Users run stale code | Tag by release, never `latest` alone |
| K5 | Memory precheck misreads containers/cgroups | Wrong preset offered | Read the cgroup limit where present, not only host totals; warn rather than hard-block |
| K6 | Two image variants double CI cost and confusion | Maintenance drag | Publish both from one workflow; document which is default |

## 7. Recommendation

**Revised 2026-07-30 after measurement.** The original recommendation named T5
and T2 as the two tasks carrying the outcome, on the reasoning that together
they removed the reason a small server could not build. Measurement kept half of
that and overturned the other half.

**T2 is now clearly the highest-value task in the package, for a reason this
document did not originally give.** Its stated benefit — a smaller image — is
measurably false: a dashboard-free build is 3.13 GB against 3.14 GB. Its real
benefit is memory. The dashboard webapp build is the single step that fails
under constraint, and removing it takes the build floor from between 512 MB and
1 GB down to 256 MB. T2 alone is what makes a small host viable.

**T5 drops from co-essential to convenience.** With T2 done, essentially any
host can build, so publishing no longer *enables* anything — it saves time and
removes the toolchain requirement. Still worth doing, no longer the thing the
package rests on.

**T6 is new and probably outranks T3, T4 and T5 on effort-to-benefit.** The
905 MB `chown -R` layer is a third of the image, created by one line, and no
task in the original package addressed it because nobody had looked at the layer
breakdown.

Revised order of value: T2, then T6, then T1, then T3 and T4, then T5. The
dependency order in the implementation plan is unchanged.

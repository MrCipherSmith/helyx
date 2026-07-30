# PRD: Deployment Simplification

Version: 1.0.1

## 1. Problem

Helyx already ships an interactive installer — `install.sh` checks
prerequisites, clones, installs the `helyx` CLI, and execs `helyx setup`, which
asks about deployment type, LLM provider, Ollama, Telegram transport, Groq, and
TTS. The wizard is not missing. What is missing is *restraint*: every heavy
component is on by default, and the wizard offers no way to say "give me the
small one".

Five concrete defects, all measured on 2026-07-30 against the running stack:

**P1 — The dashboard is mandatory and expensive.** There is no feature flag
anywhere: a grep for `ENABLE`/`DISABLE` across `config.ts` returns nothing. The
dashboard is compiled into the image by two dedicated Dockerfile stages
(`dashboard-build`, `webapp-build`), each running its own `bun install` plus
`bun run build`. The `dashboard/` source tree is 246 MB, and the resulting
`helyx-bot:latest` image is 3.13 GB. At runtime it is served from the same HTTP
server as MCP, unconditionally, at `mcp/server.ts:517`. A user who only wants a
Telegram bot pays the full cost.

**P2 — Local-model defaults are unusable on a small host.** The wizard's Ollama
path defaults to `gemma4:e4b` for both chat and summarization. That model is
9.6 GB on disk and needs roughly 12 GB of RAM to serve. The wizard offers it
without reading how much memory the host actually has. On a 2 GB VPS the
selection succeeds and the deployment then fails at first use.

**P3 — Building on the target host is the real memory ceiling.** The stack at
rest is tiny: `helyx-bot-1` holds 77 MB RSS at 0.5% CPU, `helyx-postgres-1`
holds 68 MB, and the database is 32 MB (145 MB volume). Runtime is not the
constraint — the image build is. `bun install` plus two dashboard builds needs
roughly 2 GB of free memory, so the smallest viable server is dictated by a
step that only ever needs to happen once, anywhere.

That 2 GB is an estimate, not a measurement — see specification §2.1. It is the
load-bearing number behind this whole package and should be profiled before the
work is scheduled.

**P4 — The installer cannot run unattended.** `install.sh:134` ends with
`exec helyx setup < /dev/tty`. There is no flag-driven path, so the installer
cannot be used from cloud-init, a Dockerfile, CI, or any provisioning tool.

**P5 — Local TTS has no installation path at all.** This was found while
answering Q4 and is a pre-existing defect, not a consequence of the other four.
Nothing Piper-related is in the image: `which piper` inside the running
container returns nothing. The engine and the voices both arrive through the
`./piper:/app/piper:ro` bind mount, populated by hand on the maintainer's
machine. The setup wizard downloads voices from HuggingFace but never downloads
the 52 MB runtime, so there is no automated way to obtain it. A published image
would therefore ship a `local` profile whose TTS cannot work at all — which
makes this a blocker for R5, not a nice-to-have.

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
flag alone is insufficient: it prevents route registration but leaves the image
at 3.13 GB, which does not address P3.

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

The published image MUST also carry the Piper runtime (P5), or the `local`
profile it enables is broken on arrival.

## 5. Success Criteria

| # | Criterion | Measurement |
|---|-----------|-------------|
| S1 | Minimal profile runs on 2 GB RAM — bot and database only, excluding Claude Code sessions | Bot answers in Telegram; no OOM over 24 h |
| S2 | No local build required | Install completes on a host with Docker and no build toolchain |
| S3 | Dashboard-off image materially smaller | Published tag size, compared against the 3.13 GB baseline |
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

Do all five, in the order given in [implementation-plan.md](implementation-plan.md),
but understand that they are not equally valuable.

Task 5 (prebuilt image) and Task 2 (dashboard build flag) between them remove
the entire reason a small server is currently insufficient — the build step and
the components that make it heavy. Those two carry the outcome.

Tasks 1, 3, and 4 make the result approachable rather than possible: profiles
reduce the decision surface, presets stop the user from choosing a model their
host cannot run, and the unattended path opens automated provisioning. They are
worth doing and should not be dropped, but if the work has to be cut short after
two tasks, the two that matter are 5 and 2.

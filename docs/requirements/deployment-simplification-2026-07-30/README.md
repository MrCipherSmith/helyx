# Deployment Simplification

Version: 1.2.0

## Purpose

Make Helyx deployable by a person who has never seen the codebase, on a small
VPS, through one interactive install script — without a 3 GB image build, a
9.6 GB local model download, or a dashboard nobody asked for.

## Status

`implemented` — all six tasks are built on branch
`feat/deployment-simplification`; all four open questions are decided and
recorded in [implementation-plan.md](implementation-plan.md).

Measured outcome: the image went 3.13 GB → 1.27 GB, and a dashboard-off build
now completes under a 256 MB / 2 CPU builder where the full build died at
512 MB. The `minimal` wizard asks five questions instead of roughly fifteen.

One defect was found the hard way during implementation and is recorded as
PRD P6: the wizard overwrote a live `.env` and restarted the bot with test
credentials. Both behaviours are now guarded — setup refuses to overwrite
without `--force`, and unattended runs never touch running services.

**Revised 2026-07-30 after the build was profiled.** The package was drafted on
an unmeasured assumption — that a small host cannot deploy helyx because the
build needs ~2 GB — and the measurement overturned a good deal of it. Three
findings, in order of consequence:

1. **The 2 GB figure was wrong by at least 2×.** The full build completes in
   1 GB. It fails at 512 MB, precisely inside the dashboard webapp build, and
   succeeds at 256 MB with the dashboard stages removed.
2. **The dashboard does not inflate the image.** A dashboard-free build is
   3.13 GB against 3.14 GB. Its real cost is memory, not bytes — which makes T2
   the highest-value task in the package, for a reason the original draft did
   not give. The image is instead dominated by a 905 MB layer created by a
   single `chown -R`, now task T6.
3. **Piper already ships, voices and all.** An earlier revision claimed the
   opposite; that rested on `which piper`, which only shows the binary is not on
   `PATH`. 233 MB arrives via `COPY . .`, hidden at runtime by a bind mount.

Numbers and method in specification §2.1–2.2; revised task priority in PRD §7.
Every claim about current behaviour is measured; every claim about target
behaviour is a proposal.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, scope |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks |
| [specification.md](specification.md) | Config surface, CLI surface, profile contracts, acceptance criteria |
| [implementation-plan.md](implementation-plan.md) | Six tasks, sequencing, files touched, effort |

## Scope

In scope:

- Install-wizard restructuring around deployment profiles.
- A dashboard feature flag gated at build time and at runtime.
- Lightweight local model presets with a host-memory precheck.
- A non-interactive (unattended) install path.
- Publishing a prebuilt image so end users never build locally.
- Fixing image layering — the 905 MB `chown -R` layer and the voices shipped
  inside every image (added after measurement; T6).

## Non-Goals

- Changing the runtime architecture of the bot, MCP server, or channel.
- Changing how Claude Code sessions attach or how the MCP transport binds.
- Removing the dashboard, or reducing its functionality when enabled.
- Multi-host or clustered deployment.
- Reverse-engineering documentation of existing modules — that is
  `autodoc-orchestrator` territory.

## Related Modules

| Area | Path | Relevance |
|------|------|-----------|
| Install entry point | `install.sh` | Clones, installs CLI, execs the wizard |
| Setup wizard | `cli.ts` (`setup()`, line 123) | The interactive surface being restructured |
| Config schema | `config.ts` (`EnvSchema`) | Where the new flags are declared |
| Image build | `Dockerfile` | Dashboard build stages to be made conditional |
| HTTP server | `mcp/server.ts` (line 517) | Runtime dashboard gate point |
| Dashboard | `dashboard/`, `mcp/dashboard-api.ts` | The optional component |
| CI | `.github/workflows/build.yml` | Builds the image today, does not publish it |

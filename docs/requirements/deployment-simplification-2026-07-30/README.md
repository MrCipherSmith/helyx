# Deployment Simplification

Version: 1.0.1

## Purpose

Make Helyx deployable by a person who has never seen the codebase, on a small
VPS, through one interactive install script — without a 3 GB image build, a
9.6 GB local model download, or a dashboard nobody asked for.

## Status

`spec ready` — no part of this package is implemented, but all four open
questions are decided and recorded in
[implementation-plan.md](implementation-plan.md). Every claim about current
behaviour in these documents is derived from measurements and code reads taken
on 2026-07-30 against the running local stack; every claim about target
behaviour is a proposal.

One pre-existing defect was found while resolving the open questions: local TTS
has no installation path, because neither the Piper runtime nor the voices are
in the image and the wizard downloads only the voices. It is recorded as PRD P5
and folded into task T5.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, scope |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks |
| [specification.md](specification.md) | Config surface, CLI surface, profile contracts, acceptance criteria |
| [implementation-plan.md](implementation-plan.md) | Five tasks, sequencing, files touched, effort |

## Scope

In scope:

- Install-wizard restructuring around deployment profiles.
- A dashboard feature flag gated at build time and at runtime.
- Lightweight local model presets with a host-memory precheck.
- A non-interactive (unattended) install path.
- Publishing a prebuilt image so end users never build locally.

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

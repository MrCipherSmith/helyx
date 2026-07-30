# Implementation Package — Per-Project Provider & Model Switching

**Created:** 2026-07-24
**Status:** ready-for-implementation
**Owner:** MrCipherSmith

Managed-work package authored in the flow-orchestrator Phase-1 shape
(`description` / `context` / `plan` / `tasks` / `acceptance-criteria`) but as
plain docs, so no `flow.json`/Task-Manager state exists yet.

The blocker recorded here is resolved: the CLI was renamed `gd-metapro` →
`keryx` and is now installed. This package can be adopted into a real flow with
`keryx flow init --title "Per-project provider & model switching"`, then seeding
the flow files from here.

## Goal (one line)

Let the operator, **from the Telegram command-menu**, register LLM providers and
switch **both the provider and the model** for any project — at add-time and
**on the fly for a running project** — reusing the existing Claude Code CLI and
its helyx-channel, with zero new agent-runtime plumbing.

## Files

| File | What |
|------|------|
| `description.md` | Problem, expected outcome, out-of-scope |
| `context.md` | Verified findings (this session) + affected code map |
| `plan.md` | Chosen approach, data model, launch injection, Telegram UX, trade-offs |
| `tasks.md` | Atomic tasks grouped by kind (schema/backend/tg/launch/test/docs) |
| `acceptance-criteria.md` | Verifiable `ACn` |

## The one hard rule discovered during verification

When a project uses a third-party provider, `run-cli.sh` **must `unset
ANTHROPIC_API_KEY`** before launching claude. helyx `.env` sets it, `run-cli.sh`
loads that first with "only if unset" semantics, so a project `.env` cannot
override it — and the real Anthropic key would be sent to the third-party
endpoint. This is a security-critical task (see `tasks.md` T-LAUNCH-2).

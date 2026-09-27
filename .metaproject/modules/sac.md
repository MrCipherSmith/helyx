# sac

Version: 0.1.0

## Purpose

Shared Agent Context (SAC): durable, evidence-backed, reviewer-curated project
context — Facts, Work, and Know-how — shared across workspaces, sessions, and
agents. SAC content only becomes readable context after a human reviewer
accepts a proposal; it is not a free-write scratchpad.

This is distinct from the other two "project memory" surfaces:

- **Memory** (`modules/memory.md`) — any agent can write freely; pure recall.
- **Wiki** (`modules/gdwiki.md`) — architecture and domain knowledge, curated
  by whoever edits the page.
- **SAC** (this module) — a workspace-scoped propose/review pipeline. An agent
  proposes an outcome; nothing becomes durable context until a reviewer
  accepts it.

## Commands

All commands are under `keryx workspace <subcommand>` (the module key is
`sac`; the CLI namespace is `workspace`):

- `keryx workspace create --title <title>`
- `keryx workspace list`
- `keryx workspace show <workspace-id>`
- `keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N]`
- `keryx workspace read <workspace-id> <item-id> [--max-items N] [--max-tokens N]`
- `keryx workspace propose <workspace-id> --kind <kind> --session <session-id> [--note <note>]`
- `keryx workspace review <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed>`
- `keryx workspace collaboration <workspace-id>`
- `keryx workspace policy-readiness`

There is no session-to-workspace linkage: every call above needs an explicit
`workspaceId`. Discover ids with `keryx workspace list`.

## Data

- `.metaproject/workspaces/` — workspace state (created lazily by
  `WorkspaceService` on first `workspace create`).
- `.metaproject/context-operations/` — proposal/review evidence (created
  lazily by `FwkReadService`/the proposal lifecycle service).

## Entry

- `keryx workspace list`

## Skills

- `skills/sac/`

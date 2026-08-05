# Two answers to which containers exist, and the analyst gets the one that hides the dead

Status: formalized
Source: user description → package `docs/requirements/self-observability-2026-08-05` (defect D3)

## Problem

The supervisor asks Docker which containers exist in two places, with two
different commands.

`sendStatusBroadcast` (`scripts/supervisor.ts:655`) runs `docker ps -a` and
carries a comment explaining why: `docker ps` lists only what is running, so a
crashed container does not appear as broken — it vanishes, and a vanished
container is indistinguishable from one that was never there. That is how the
red state stayed unreachable for weeks, and flow 004 fixed it there.

`collectSystemSnapshot` (`scripts/supervisor.ts:1116`), which feeds the Gemma
health analyst every ten minutes, still runs `docker ps` without `-a`. The
analyst is asked to judge system health from a list that cannot contain a dead
container, and it also has no ownership filter, so what it does contain may
belong to someone else entirely.

The defect is not that one call site is wrong. It is that there are two call
sites at all: the same question, answered twice, free to drift again.

## Expected Outcome

- One function answers "which containers are ours, and what state are they in".
  Both consumers call it. `docker ps` appears once in the supervisor.
- The Gemma snapshot contains exited containers, and only containers this
  supervisor is answerable for.
- An unreadable listing is reported as unreadable to the analyst, rather than as
  an absence of containers — the same distinction `dockerListingUsable` already
  makes for the broadcast.

## Out of Scope

- Changing the ownership rule, the classification allowlist, or the alert
  condition. Those were decided in flow 004 and are reused verbatim.
- What the analyst does with the snapshot, and its prompt.
- The tmux listing in the same function.

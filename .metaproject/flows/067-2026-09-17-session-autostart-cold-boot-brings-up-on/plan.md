# Implementation Plan

Status: chosen, approved by the operator on 2026-09-17

## Approach

Two records, one decision function, and one change of order.

**The two records.** `projects.autostart` says which projects a *cold* boot is
allowed to start; it is false everywhere except `helyx`. A snapshot in
`host_state` says which windows were live when the last teardown began; it is
what a *restart* restores. They answer different questions and neither can
stand in for the other — a cold boot must ignore whatever was running before
the host went down, and a restart must ignore the autostart flag.

**The decision function.** `decideStartSet` in `sessions/restore-plan.ts` takes
the boot id, the stored boot id, the snapshot and the project list, and returns
the set to start plus a one-line reason. It touches no tmux and no database, so
every branch is unit-testable — the shape `sessions/tmux-server.ts` uses for
exactly this reason, and the reason the 2026-08-05 restart incident is covered
by tests today.

**The change of order.** `tmuxStop` takes the snapshot *before* `kill-session`,
not after. This is the whole bug in one line: the current order destroys the
answer and then asks the question.

Cold versus restart is decided by the host boot id
(`/proc/sys/kernel/random/boot_id`) compared against the one stored at the end
of the last successful start. Alternatives considered and rejected: a snapshot
freshness timeout (arbitrary, and wrong for a host that was down for an hour),
and "no snapshot means cold" (a snapshot survives a reboot, so it cannot tell
the two apart at all).

`tmux_stop` deliberately keeps the snapshot: it means "put the sessions down",
and the `stack_up` that follows it in the same boot is a restore, symmetric
with `bounce`.

## Steps

1. Migration in `memory/db.ts` (`migrate()`, idempotent, runs at bot start):
   `projects.autostart boolean not null default false`, seeded true for
   `helyx` only when the column is newly added; `session_state_events` for the
   audit trail; `host_state(key, value, updated_at)` for the boot id and the
   snapshot.
2. `sessions/restore-plan.ts` — `decideStartSet` plus the snapshot
   encode/decode, pure, no I/O.
3. `sessions/state-machine.ts` — `transitionSession` writes a
   `session_state_events` row next to the existing broadcast.
4. `cli.ts` — `loadProjects` reads `autostart`; `tmuxStop` snapshots live
   windows first, then kills; `tmuxStart` starts only the set `decideStartSet`
   returns, and records the boot id after a successful start. The warm branch
   starts only the missing windows *from that set*.
5. `scripts/admin-daemon.ts` — `proj_start`/`proj_stop` write the audit row and
   update the snapshot; the `proj_start` fallback on a dead tmux server starts
   the requested project alone instead of `up`.
6. Unit tests for `decideStartSet` and the snapshot codec.
7. Verification: `bun run typecheck`, `bun test tests/unit/`, `bun run dupes`.

## Risks

- **The snapshot and tmux disagree.** Mitigated by reading the snapshot from
  `tmux list-windows` — the live truth — rather than from `sessions`, whose
  rows can be stale (session 3 sat at `active` through a reboot today).
- **A restart with an empty snapshot would start nothing.** `decideStartSet`
  falls back to the autostart set, never to the empty set: a restart that
  brings up nothing at all is the 2026-08-05 outage.
- **Duplicated knowledge.** The set of projects to start would be easy to
  compute in two places (`cli.ts` and `admin-daemon.ts`). It is computed in
  `restore-plan.ts` only; `bun run dupes` is part of verification because this
  repository's recorded failure mode is exactly that divergence.
- **Migration on a live DB.** All statements are `IF NOT EXISTS`/`ADD COLUMN IF
  NOT EXISTS`; the `helyx` seed is guarded so a later manual change to the flag
  is not overwritten on every boot.

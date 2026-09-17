# Helyx v1.59.0 Release Notes

**Released:** 2026-09-17

A reboot used to hand the operator the entire fleet: fifteen Claude Code
sessions, whichever of them was wanted. This release makes a cold boot start one
session and a restart restore the ones that were actually running.

## What's New

### A reboot brings back one session

Every path that started the session half started every project. `tmuxStart`
read the whole `projects` table and nothing narrowed it, so a host reboot, a
code deploy and a recovery button were indistinguishable — all three returned
every configured project.

`projects.autostart` now says what a cold boot may bring up. `helyx` is the only
project flagged, seeded once and never overwritten on a later replay of the
migration, so an operator who changes the flag keeps that decision. Everything
else is started on demand from Telegram, the way it was already being used.

### A restart brings back what was running

A restart could not do better than "all of them", because the evidence was
destroyed by the restart itself: `tmuxStop` killed the tmux session and *then*
marked every remote session inactive. By the time the start ran, there was
nothing left to read.

The snapshot is now taken from tmux **before** the kill, and it is what
`bounce`, `full_restart`, `host_restart` and the `stack_up` after a `tmux_stop`
restore. Stop a project from Telegram and it stays stopped across the next
restart; leave three running and three come back.

Cold is told from restart by the host boot id — new after every reboot, stable
while the machine is up. A freshness timeout on the snapshot was considered and
rejected: it answers "how old" when the question is "was there a reboot".

The decision is a pure function (`sessions/restore-plan.ts`) and never returns
the empty set. An empty, missing or unreadable snapshot falls back to the
autostart set, because a restart that brings up nothing is the failure mode of
2026-08-05.

### Session status changes are written down

`sessions.status` is one mutable column, and the commands that matter most
rewrite it in bulk. `session_state_events` now records each change with the
status being left as well as the one taken, plus who asked and why — "ended up
inactive" and "went from active to inactive" are different facts, and only the
second says a session was stopped.

### One project means one project

`proj_start` on a host whose session half is down fell through to `up`, which
started everything. After this release that state is the ordinary one after a
reboot, so it now starts only the project that was asked for — matched by the
name stored in `projects`, not by the directory's, so a project added with
`helyx add . --name <other>` works too.

### 🧹 Clear context, and a `/projects` keyboard that fits

A per-project Clear context action sends Escape then `/clear` to the live
session through the existing `tmux_send_keys` path, with its own confirm step,
shown only while the project is active. The keyboard itself was rearranged: a
header row, icon-only controls, Stop/Start alone on its row while active, ⚙️
paired with 🧹 below.

## Upgrade

Migration 56 adds `projects.autostart`, `host_state` and
`session_state_events`. It runs from `main.ts` inside the bot container, so the
order matters:

```bash
docker compose up -d --build bot     # applies migration 56
systemctl --user restart helyx-admin # host daemon, after the table exists
bun cli.ts up                        # cold start: the autostart set only
```

A host daemon restarted before the bot is rebuilt logs
`relation "host_state" does not exist` and carries on — the write is guarded —
but no snapshot is recorded until the table is there.

After the upgrade the first `up` is judged a cold start and brings up `helyx`
alone. Start the others from `/projects`; the next restart will remember them.

To autostart more than `helyx`, set the flag directly for now — a Telegram
toggle is not in this release:

```sql
UPDATE projects SET autostart = true WHERE name = 'keryx';
```

## Known Limits

`up -s` (split panes) puts every project in one window, so the snapshot holds
one name and a restart brings back one project. Documented rather than fixed:
the daemon never passes `-s`, and pane-level restore is a larger change.

## Flow

Flow 067, PRs
[#117](https://github.com/MrCipherSmith/helyx/pull/117),
[#118](https://github.com/MrCipherSmith/helyx/pull/118) and
[#119](https://github.com/MrCipherSmith/helyx/pull/119). The review record —
including the six findings #118 closed — is in
`.metaproject/flows/067-2026-09-17-session-autostart-cold-boot-brings-up-on/reviews/`.

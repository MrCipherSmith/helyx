# Session autostart: cold boot brings up only helyx, a restart restores what was live

Status: formalized
Source: user description (2026-09-17)

## Problem

Every path that starts the session half starts *every* project. `tmuxStart`
(`cli.ts:1585`) reads the whole `projects` table through `loadProjects`
(`cli.ts:1425`) and opens a window per row — fifteen of them today. `bounce`
(`cli.ts:2313`), `stack_up` (`scripts/stack-up.ts:86`) and `tmux_start`
(`scripts/admin-daemon.ts:406`) all reach that same function, so a host reboot,
a code deploy and a recovery button are indistinguishable from each other: all
three hand back fifteen Claude Code sessions.

Two distinct things are wrong with that.

1. **A cold boot should not resurrect the fleet.** After the host restarts the
   operator wants one session — `helyx`, the one from which the others can be
   started from Telegram. Fourteen more are fourteen models burning tokens on
   projects nobody asked about.
2. **A restart should restore what was actually running, and it cannot.** The
   information needed to answer "which sessions were live when the restart was
   pressed" is destroyed by the restart itself: `tmuxStop` (`cli.ts:1749`) kills
   the tmux session and *then* sets every remote row in `sessions` to
   `inactive`. By the time `tmuxStart` runs there is nothing left to read, so
   the only restore it can perform is "all of them".

There is also no durable record of session status *changes* at all. `sessions`
holds a current status maintained by `transitionSession`
(`sessions/state-machine.ts`), tied to the channel connection and wiped
wholesale by `tmuxStop`; nothing says when a session was started or stopped, by
whom, or why.

A third, smaller instance of the same bug: `proj_start` on a host with no tmux
server falls through to `runCommand("up")` (`scripts/admin-daemon.ts:463-473`),
so asking Telegram for *one* project on a cold host starts all fifteen.

## Expected Outcome

- A cold start — the first `up` after the host booted — brings up only the
  projects flagged for autostart. `helyx` is the only one flagged by default.
- A restart within the same boot (`bounce`, `full_restart`, `host_restart`,
  and `stack_up` after `tmux_stop`) brings back exactly the windows that were
  live at the moment the restart was invoked, and nothing else.
- Session status changes are recorded durably, with actor and reason, so the
  restore set is read from a record rather than guessed.
- `proj_start` against a dead tmux server starts the requested project only.
- The decision — which projects to start, and why — is a pure function covered
  by unit tests, in the shape `sessions/tmux-server.ts` already established.

## Out of Scope

- Changing how a window restarts Claude Code after a crash. `run-cli.sh`
  already restarts it in place and the watchdog only observes; neither is
  touched.
- Reworking `sessions`/`projects` beyond the columns and the audit table this
  needs.
- Any restart of the running stack. The change reaches both halves (a migration
  in the bot container, `cli.ts` on the host) and therefore needs a
  `full_restart` — which is the operator's call, taken after this flow reports
  ready, not part of it.
- Telegram UI for toggling the autostart flag. The flag is settable in the DB
  and is proposed as follow-up work, not delivered here.

# Two restarts that run at once, and a command that says done before it starts

Status: frozen
Source: review finding, 2026-08-06

## Problem

`bounce`, `host_restart` and `full_restart` all do the same thing with their
work: spawn it detached and immediately set `result = { ok: true }`. The daemon
writes `status = 'done'` milliseconds later. The work itself has barely begun —
`cli.ts bounce` kills a tmux session, waits, and starts a window per project;
`full_restart` builds a Docker image first. Minutes, reported as done in about a
second.

Nothing else holds the line. The only guard is a check at enqueue time in
`bot/commands/system.ts`: refuse if a row with **the same command name** is
`pending` or `processing`. Two consequences, and both are reachable by an
operator doing something reasonable.

**The window is about a second.** The row flips to `done` before the work
starts, so pressing the same button again a moment later enqueues a second
restart that runs concurrently with the first.

**Different names were never excluded at all.** "🔄 Bounce" and "♻️ Полный
рестарт" are different rows. Press one, watch the panel stop showing it as
pending — which it does almost at once — conclude it finished, press the other.
Two `tmux kill-session -t bots` / `tmux new-session` sequences now interleave on
one session name, and one process tears down the windows the other has just
created. Nothing in either log says so; the projects are simply gone.

**And there is a third door.** `scripts/host-ingress.ts` handles `/up` by
calling `bringStackUp` directly, with no queue and no check. The door is armed
when the bot is confirmed dead — but the bot being dead does not stop
`admin-daemon.ts`, which has its own database connection and may well be
half-way through a `host_restart` at that moment. `/up` then runs a second,
entirely uncoordinated bring-up over the top of it.

This is the code an operator reaches for when something is already broken. It is
the worst possible place for a race, and the one where a race is least likely to
be noticed: both halves report success.

## Expected Outcome

Two restarts cannot run at the same time, whatever they are called and whichever
door they came through. A restart that is still working says so — to the
operator who asks, and to the next restart that tries to start. A restart that
dies without finishing does not wedge the stack for ever.

## Out of Scope

- Making the detached work interruptible or resumable. Stopping a second
  restart from starting is a different problem from stopping the first.
- Reporting progress of a running restart beyond "still going, started at T".
  What the operator needs here is a refusal with a reason, not a progress bar.
- The `restart_admin_daemon` command, which replaces the daemon process and is
  neither long-running nor destructive to the tmux session.
- Bounding the tmux commands elsewhere in the daemon. Only the docker step was
  unbounded, and that is fixed separately.

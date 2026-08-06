# A restart that reports success while half the system is dead, and no way to see it from Telegram

Status: formalized
Source: user report + `restart-problem.md` (2026-08-05 incident)

## Problem

On 2026-08-05 a full rebuild and restart left the containers healthy and every
Claude session dead, and every interface said it had worked.

The mechanism is a stale systemd user scope. `helyx-tmux.scope` is transient and
exists to keep the *first* tmux server out of `helyx-admin.service`'s cgroup, so
that restarting the admin service does not take every CLI pane with it. But the
scope tracks the tmux **server**, not the `bots` **session** — and the server
outlives `bots` whenever any other session (a bench run, in this case) is still
attached to it. `tmuxServerScope()` in `cli.ts` then runs
`systemd-run --user --scope --unit=helyx-tmux`, which fails with "Unit
helyx-tmux.scope was already loaded or has a fragment file" for as long as that
server lives. Its only defence is `reset-failed`, which clears a *failed* unit
and does nothing at all to an *active* one.

Three things turned that bug into an outage the operator could not end.

**Every door leads to the same broken room.** `stack_up`, `bounce`, `tmux_start`
and `proj_start` are four different buttons that all reach `helyx up` and so all
reach the same failing branch. There is no second path.

**The failure is invisible.** `startWindow()` and `tmuxStart()` call `run()` and
never look at what it returned, so `console.log("✓")` prints regardless. That
green tick reaches `admin_commands.status = 'done'`, and from Telegram the
restart looks like it worked while `/tmp/helyx-bounce.log` fills with
"can't find session: bots".

**The emergency door was closed by design.** `scripts/host-ingress.ts` polls
Telegram from the host so an operator can recover when the stack is down, and it
arms only after the bot fails two consecutive health probes. In this incident the
bot was healthy the whole time. The one failure mode it cannot help with is
exactly this one: sessions dead, bot alive.

Recovery required shell access to the host. From Telegram there was no way to
fix it and no way to find out what was wrong.

Two smaller gaps surfaced alongside it. `/now` is registered as a handler
(`handlers.ts:176`) but appears in none of the three places a command becomes
visible, so nobody can find it. And there is no single command for "restart the
containers" or "restart everything that is not a container" — the two halves the
operator actually thinks in.

## Expected Outcome

- A restart works when a tmux server is already running, which is the normal
  case on this host and the one that broke.
- A restart that fails says so — in the CLI's exit code, in the command queue,
  and in Telegram. No green tick survives a failed `new-session`.
- The operator can restart either half by name, from Telegram, and can see from
  Telegram whether the session half is actually there.
- `/now` is findable.

## Out of Scope

- Widening `host-ingress` to poll while the bot is alive. Telegram permits one
  `getUpdates` reader per token; a second one earns 409 Conflict and the two
  then lose each other's updates. The bot is alive in this scenario, so the fix
  belongs in the bot.
- Killing the bench tmux sessions to clear the current stale scope. That is an
  operational decision the user has not made, and the code fix must work without
  it.
- Any change to the Docker half's build or image contents.

# Implementation Plan

Status: ready

## Approach

Fix the root cause where it is, then make every path that reaches it honest,
then give Telegram both the truth and the two buttons that match how the
operator thinks about the system.

The ordering matters: the visibility work is worth nothing on top of a start
path that still fails, and the new commands must not become a third and fourth
door into the same broken room. So the shared helper comes before the commands
that use it.

## Steps

1. **`tmuxServerScope()` decides by server, not by unit state** (`cli.ts`).
   Extract the decision into a pure, exported function so it can be tested
   without systemd or tmux: given "is a tmux server reachable", return either no
   prefix or the `systemd-run` prefix. Keep the scope for the no-server case —
   it still solves the cgroup problem it was written for — and add `stop` before
   `reset-failed` there, since a unit left behind by a dead server is stale
   whatever systemd calls its state.

2. **Propagate failure through `startWindow` / `tmuxStart`** (`cli.ts`).
   `startWindow` returns a result instead of `void`; `tmuxStart` prints red on
   failure, collects what failed, and sets a non-zero exit code. The green tick
   moves behind the check.

3. **Verify, do not trust** (`cli.ts` + a new pure helper).
   After a start or a bounce, count the windows in `bots`. Zero windows is a
   failure even if every step claimed success — that is the exact shape of the
   incident. The counting and the verdict are pure and tested; only the `tmux
   list-windows` call is not.

4. **Honest status in the queue** (`scripts/admin-daemon.ts`).
   Session-start commands record the real exit status and stderr. A failed start
   must not land as `done`.

5. **A shared helper for the host half** (`scripts/restart-host.ts`, new).
   One function that restarts the non-container half and reports what it did,
   taking its shell the way `stack-up.ts` does. Both the existing `bounce`
   button and the new `host_restart` command call it, so there is one code path
   to keep correct.

6. **The container half by name** (`scripts/restart-docker.ts`, new).
   `docker compose up -d` then `docker compose restart`, each step reported
   separately, same shape as `stack-up.ts`.

7. **tmux ground truth for the panel** (`bot/commands/system.ts` + host probe).
   The panel currently counts rows in `sessions`, which cannot tell "the windows
   never started" from "the windows started and did not register". Add the host
   facts — session present, window count, scope state — as their own lines.

8. **Command surface** (`main.ts`, `bot/handlers.ts`, `bot/commands/menu.ts`,
   `bot/commands/system.ts`).
   Register `/restart_docker` and `/restart_host` at all three levels, and put
   `/now` where it can actually be found — both `setMyCommands` lists and a
   `/menu` group that survives forum topics.

9. **Tests** for the scope decision, the failure propagation, the zero-window
   verdict, and the two new command payloads.

## Risks

- **The stale scope is live right now.** `helyx-tmux.scope` has been active
  since 12:35 UTC, held up by four bench sessions, and `bots` was recreated by
  hand on that server. Step 1 is precisely the case that makes this survivable,
  but until the new code is *running*, a bounce still reproduces the outage.
  Nothing in this flow may be verified by bouncing the live sessions.
- **Verification cannot use the real thing.** The failure only reproduces with a
  tmux server up and `bots` gone, which is the outage itself. Hence the pure
  functions in steps 1 and 3: the decision and the verdict must be testable
  without staging the incident.
- **`channel.ts` ships on bounce, not on build.** Anything here that the channel
  subprocess imports is not live until sessions restart — the trap the incident
  report already names. Changes are confined to the CLI, the daemon and the bot
  so that the container rebuild plus a later session restart is enough.

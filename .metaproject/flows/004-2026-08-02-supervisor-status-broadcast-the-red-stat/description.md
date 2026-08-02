# supervisor status broadcast — the red state is unreachable

Status: formalized
Source: user description (заход 4 of the coverage programme)

## Problem

`scripts/supervisor.ts` is still the worst hotspot in the project and is 4%
covered. Its 5-minute status broadcast is the thing that decides whether an
operator is *notified* or merely has a message quietly edited under them —
v1.49.0 introduced exactly that: "edits message in-place (silent) when
healthy; delete+send (notification) only when stuck queue or 🔴 docker
container detected".

**The docker half of that condition cannot fire.**

Container health is decided by:

```ts
const running = !status.toLowerCase().startsWith("exited")
             && !status.toLowerCase().startsWith("dead");
```

against the output of `docker ps` — without `-a`. `docker ps` lists only
running, restarting and paused containers; an exited or dead container is not
in the output at all. So the blacklist matches nothing that can ever appear,
every listed container is painted 🟢, and `hasProblems` — which looks for a
line starting with 🔴 — is left with only the stuck-queue term.

What is lost is precisely the states that mean trouble and *are* listed:

| `docker ps` status | Means | Painted today |
|---|---|---|
| `Up 3 days (healthy)` | fine | 🟢 correct |
| `Up 2 minutes (unhealthy)` | healthcheck failing | 🟢 **wrong** |
| `Restarting (1) 5 seconds ago` | crash loop | 🟢 **wrong** |
| `Up 3 days (Paused)` | frozen | 🟢 **wrong** |

A crash-looping bot container is reported green and produces no notification.

There is a second problem in the same place: `hasProblems` decides a control
question by grepping a rendered presentation string for an emoji
(`dockerLines.some(l => l.startsWith("🔴"))`). Change the icon and
notifications stop silently.

None of the broadcast's four decisions — container health, session state,
queue summary, notify-or-not — is tested.

## Expected Outcome

The four decisions live in an importable module with tests, the supervisor
calls them, a restarting or unhealthy container is reported red, and the
notify-or-not decision reads structured state rather than a rendered line.

## Out of Scope

- The SQL in `sendStatusBroadcast`, and the broadcast's Telegram calls.
- Whether `docker ps -a` should be used instead. Widening what is listed is a
  product decision about how much noise the status message carries; this flow
  fixes the classification of what is already listed.
- The rest of `supervisor.ts` — the hung-session and stuck-queue loops keep
  the coverage they got in заходы 1 and 2.

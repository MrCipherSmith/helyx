# The status vanishes at the reply, and the work goes on without it

Status: formalized
Source: operator, 2026-08-05 — an agent that replies "starting the subagents"
and is then silent for minutes.

## Problem

The status message is the only thing that says work is happening. It is deleted
the moment a reply is sent (`channel/tools.ts:458`), and a reply is very often
not the end of the work: "запускаю сабагентов", "собираю ветку", "жду CI". From
that moment the operator sees nothing at all, however long the turn continues.

The code says this was meant to be handled. `channel/tools.ts:326` reads:

> Do NOT stop the progress monitor here — Claude may send an early
> acknowledgment reply and then continue working. `schedulePostReplyCheck` will
> stop the monitor after 20s if Claude turns out to be truly idle.

**`schedulePostReplyCheck` is never called.** It exists, at
`channel/status.ts:460`, and it does exactly the right thing — sees activity
after the reply and opens a continuation status. Nothing anywhere invokes it;
its only mention in the repository is the comment promising that it will run.

And the monitor really does keep running, and really does keep calling
`updateStatus`, which returns early at `channel/status.ts:843` when no status
is open — "do not create an orphan". So every line of post-reply work arrives
and is dropped on the floor.

## Expected Outcome

- A reply ends a *step*, not the work. While the session is still doing
  something, the status is there, pinned, and moving.
- The status closes on silence, not on a reply.
- A new user message is not delayed by a status that is only a continuation.
- The dead method and the comment that promises it are gone.

## Out of Scope

- What a subagent is doing while it runs — that is flow 045, and without it a
  continuation status during a fan-out shows a true but motionless line.

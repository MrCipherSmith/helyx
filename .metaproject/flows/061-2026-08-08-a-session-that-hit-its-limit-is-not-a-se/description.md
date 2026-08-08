# A session that hit its limit is not a session that hung

Status: formalized
Source: operator request, 2026-08-08 — "I would like the supervisor to also be told when limits run out, and when a session hangs"

## Problem

Two requests, and they are in very different states.

### Hangs are already detected — for half the sessions

`checkHungSessions` runs every 60 s and does the job well: it skips a session
waiting on an open question, and since flow 059 it skips one that is folding
its context; it captures the pane and reads whether the spinner is turning, so
the button says "Restart (Claude is working!)" when it is; it records an
incident.

But the query begins `JOIN active_status_messages asm`, and that row is written
in exactly one place — `channel/status.ts`, when the channel sends a Telegram
status message for a turn. A turn typed straight into the tmux pane produces no
status message, so no row, so **a session driven from the terminal cannot be
found hung**. It is not that the detector is wrong about it; the detector cannot
see it at all.

This is the same blind spot flow 054's review found from the other side: `busy`
in the context-pressure loop means "no Telegram turn in flight", not "the
session is idle".

### Limits are not detected at all

Nothing in the repository looks for them. Every match for "limit", "quota" or
"429" is about Telegram's rate limit, a text-to-speech retry, or a reviewer's
balance. The sessions themselves are unwatched.

And they should not be, because Claude Code says so plainly. It writes its API
errors into the transcript with `isApiErrorMessage: true`, and the text carries
the reset time:

```
You've hit your session limit · resets 5:30pm (UTC)
You've hit your weekly limit · resets 2pm (UTC)
API Error: 529 Overloaded
Prompt is too long
API Error: Unable to connect to API (ENOTFOUND)
```

Measured across this project's transcripts: **twelve limit events — eleven
session limits and one weekly** — on 2026-07-07, 08-02 (three), 08-03 (two),
08-04, 08-06 (four) and 08-08. `isApiErrorMessage` appears in zero lines of
code.

### And the two failures look identical from outside

A session that has hit its limit stops answering. Five minutes later the
hung-session loop finds it stale and offers the operator a restart button. The
restart does nothing — the limit is on the account, not the process — and the
session comes back and stops again. The operator is told "not responding" when
the truth is "not allowed to respond until 5:30pm", which is a different problem
with a different remedy: wait, or switch provider.

## Expected Outcome

- A limit event in a session's transcript is reported to the supervisor topic,
  naming the kind of limit and the time it resets.
- A session under a limit is not reported as hung, and is not offered a restart
  that cannot help.
- A session worked on from the pane can be found hung, like any other.
- The other API errors in that stream — overload, a prompt too long, a lost
  connection — are distinguishable from each other and from silence.

## Out of Scope

- Doing anything about a limit automatically: switching provider, queueing work
  until reset, or pausing the session. This flow makes the state visible; what
  to do about it is the operator's call and a later decision.
- The supervisor's stale header comment, which documents six loops where
  thirteen run. Worth fixing, not here.

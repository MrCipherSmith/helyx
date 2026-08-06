# The status says how long, not whether anything is still moving

Status: frozen
Source: user description

## Problem

The status message answers "how long has this been going" and "what did it do",
and neither of those is the question the operator actually has. The question is
"is it still moving". A turn that has been thinking for four minutes and a turn
that died three minutes ago render identically: same spinner, same elapsed
clock, same last block of activity. The spinner turns because a timer turns it,
not because the session did anything.

Three specific gaps, all in the same message:

**Nothing says a subagent is running.** Flow 045 taught the monitor to read
subagent transcripts — `findSubagents` locates them, up to three are followed,
and their lines arrive prefixed with `[label]`. But that is all: the lines are
mixed into the same stream as the parent's, so two agents working in parallel
look like one session talking to itself, and an agent that is running but has
not written a line yet looks like nothing at all. The operator's own words for
it: an agent says "запускаю сабагентов" and the status goes still.

**Nothing says when the last event was.** `StatusManager` records
`lastMonitorActivity` on every update and uses it only to decide how fast to
spin. The number itself — three seconds ago, or three minutes — never reaches
the message, and it is the one number that separates working from hung.

**The raw pane has no heading.** The `<pre>` block is nine lines of terminal,
which is the right thing to keep and the wrong thing to read first. There is no
one-line answer above it.

## Expected Outcome

The status message says, at a glance and without expanding anything: how long
since the session last did something, how many subagents are running and what
they are, and one line of what is happening now. The raw pane stays exactly as
it is underneath.

## Out of Scope

- Buttons on the status message and releasing a stuck queue — flow 050.
- Calling a model to write the summary. `/now` does that on request; a live
  status that redraws every few seconds must not, so the summary here is
  derived from the events already in hand.
- Changing what the pane shows or how often it is captured.

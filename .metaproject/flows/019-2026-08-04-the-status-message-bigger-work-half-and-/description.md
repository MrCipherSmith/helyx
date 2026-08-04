# The status message: a bigger work half, and a statistics half

Status: formalized
Source: operator request with screenshot, 2026-08-04

## Problem

The status message is the only window into a session for someone who does not
watch the terminal — and it was showing ten lines of activity with the rest
behind a spoiler, six lines of pane, and every line clipped at fifty to
sixty-five characters. What reached the operator was a summary of a summary.

It was also the least tested code in the project relative to how much it is
read: the rendering could only be reached by having a live session produce
output.

Two specific complaints, both fair. Terminal output rendered in a proportional
font, so tree characters, aligned columns and diffs lost their shape. And the
message said how long it had been working without saying what it was working on
— four minutes means something different depending on the question.

## Expected Outcome

Two halves.

**The work.** Fifty per cent more of everything: fifteen activity lines rather
than ten, nine pane lines rather than six, and per-line clipping widened from
50/55/60/65 to 75/83/90/98. The activity is an *expandable* blockquote rather
than a spoiler — everything is in the message and the message stays short until
tapped, which is what "if it does not fit, make it bigger" actually asks for.
The pane is `<pre>`, the only Telegram tag that keeps a diff looking like a diff.

**The statistics.** Tokens, tools and files as before, plus the question being
worked on.

Sizing is by character budget rather than line count, because the two are not
the same: forty short lines and eight long ones cost the same message, and only
one of those used to be allowed. A message over Telegram's 4096 limit is
rejected outright, so the operator would see nothing rather than something.

## Out of Scope

The voice recap, which the operator asked to leave as it is.

# An expired question stops looking like a live one

Status: formalized
Source: operator report, 2026-08-03

## Problem

The question bridge shipped with a hole, and the operator found it the same day.

A tool call was rejected in the terminal at 16:14:46. The hook had already
started; it posted the question anyway at 16:15:03 — seventeen seconds *after*
the rejection — and then waited out its full nine and a half minutes before
marking the request expired.

The hook cannot know its work has become moot. Nothing tells it: Claude Code
abandoned the call, the hook process kept running, and the socket stayed open,
so the disconnect handling this flow's predecessor added never fired. There is
no signal to listen for.

What the operator saw was three questions with live-looking buttons. Tapping one
some minutes later produced "this question is no longer waiting" — correct, and
the first moment they could possibly have known.

## Expected Outcome

The messages stop pretending. When a request expires — by timeout, or because
the client went away — each of its messages loses its keyboard and gains a line
saying the question is no longer waiting.

Not a fix for the root cause, which is not reachable from here: nothing informs
a running hook that its tool call was abandoned. This makes the consequence
visible at the moment it happens rather than at the moment someone taps.

## Out of Scope

Detecting abandonment itself. It would need a signal Claude Code does not send,
or a poll of the session's tool state that does not exist. Recorded as open.

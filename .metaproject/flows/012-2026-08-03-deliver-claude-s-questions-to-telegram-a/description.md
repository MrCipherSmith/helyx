# Deliver Claude's questions to Telegram, and answer them from there

Status: formalized
Source: user report, 2026-08-03

## Problem

`AskUserQuestion` is a built-in tool that draws its own selector in the
terminal. It is not a permission request — and every path helyx has for getting
a prompt in front of the operator is built on permission requests. The pane
detector requires the literal "Do you want to proceed?" together with a
highlighted `❯ 1. Yes`; a question selector renders neither. The string
`AskUserQuestion` did not appear anywhere in this codebase.

The consequence, from the keryx session transcript: a question asked at
13:19:30Z, answered at 13:40:58Z. Twenty-one minutes with the session standing
still and the operator — who works from Telegram and does not watch the
terminal — not told anything about it.

Something did arrive, and it was worse than nothing: at 13:26 and 13:31 the
supervisor sent "session is not responding". The session had not failed. It was
waiting for an answer, and the alert carried no question, no options and no way
to reply.

## Expected Outcome

A question asked in any project reaches the operator in Telegram with a button
per option, and tapping one answers the session.

The seam is a `PreToolUse` hook, which receives the question and its options as
structured data before the selector is drawn. Its default timeout is 600
seconds — the same wait the permission flow already allows — so the hook can
hold the call open until an answer arrives.

Nothing touches the tmux pane. That was the first design: let the selector
render and type the answer with `tmux send-keys`, as terminal permission
dialogs are answered. It is worse, and it was abandoned after a probe written
to explore it sent a keystroke while no selector was up — the key landed in the
prompt and became a message sent in the operator's name. A design that can do
that on a misjudged moment should not be shipped when a better one exists.

A `PreToolUse` hook cannot return a synthetic tool result; it can only allow,
deny, or edit the input. So the answer comes back as a *refusal* carrying the
choice in its reason, which is text the model reads.

And the supervisor stops calling such a session hung, because it can now tell
"waiting for the operator" from "stopped responding".

## Out of Scope

- Free-text questions. A question with no options cannot be answered by tapping
  a button and is left to the terminal.
- Multi-select. `multiSelect` is carried through but every question is answered
  with a single tap for now.
- Replacing the terminal selector. Whenever this path cannot deliver — no chat,
  a failed send, or no answer inside the window — the hook is silent and the
  selector appears exactly as before. Nothing that works today stops working.

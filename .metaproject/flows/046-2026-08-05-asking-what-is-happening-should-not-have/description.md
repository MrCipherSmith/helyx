# Asking what is happening should not have to wait for the session to answer

Status: formalized
Source: operator, 2026-08-05 — "я не хочу постоянно писать какой статус и в
некоторых случаях не получать ответа".

## Problem

The only way to find out what a session is doing is to ask it, and the asking
goes through `message_queue`. The poller holds a message back while the chat is
busy — deliberately, so each message gets its own turn — so the question is
answered when the turn ends, which is exactly when the answer stops being
interesting. If the session is stuck, it is never answered at all.

So the question the operator asks most often is the one the system is worst at
answering, and it costs a turn and a model call to answer something that is
already written down: the session's transcript says what it is doing, and since
flow 045 it says what its subagents are doing too.

## Expected Outcome

- One command answers immediately, from the transcript, without touching the
  session: what it is doing now, for how long, which subagents are running,
  what it is waiting on.
- Two lines of interpretation from the local model under the facts, because
  "what is left" is not in the transcript and a cheap model reading the tail
  can say it.
- A button for the case where the session's own answer is what is wanted, which
  queues a question the way a message always has.
- The answer is visibly not a reply: its own shape, and one message that is
  edited rather than a new one each time.

## Out of Scope

- `/btw` through `tmux send-keys`. It races the operator for the terminal's
  input, and its answer would have to be told apart from a real answer by
  guesswork. Considered and rejected on 2026-08-05.
- Anything that interrupts a running turn.

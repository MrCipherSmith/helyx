# Implementation Plan

Status: formalized

## Approach

### The facts, from what is already on disk

`utils/session-snapshot.ts`: given a project, resolve its transcript the way
the monitor does, read the tail of it, and answer four questions — what the
last thing done was and how long ago, how many tools and files this turn, which
subagents are live and what each is doing, and what the session is waiting on.

Pure but for the read, and the read is injected, so the whole thing is testable
over a fixture tree.

The waiting-on part is the one worth care: a permission prompt, an open
question and an idle session look different in the record and mean different
things to an operator deciding whether to wait.

### Two lines of interpretation

`callGemmaForHealth` in `scripts/supervisor.ts` already talks to the local
model for exactly this kind of job — a snapshot in, a short answer out, cheap
and independent of the session. The same shape, a different prompt: the tail of
the transcript in, "what it is doing and what is left" out, two lines.

It is allowed to fail. A model that is down costs the two lines and nothing
else; the facts above them are the answer.

### The command

`/now` in Telegram, and a button beside it. It renders one message and edits
that same message on every later press: ten presses in a topic must not be ten
messages.

The shape is deliberately not a reply's — a compact card, monospace where the
work lines go — because the operator has to be able to tell at a glance that
this is the system talking about itself rather than the session answering.

### The button that does ask the session

"Спросить сессию" queues a question through `message_queue`, exactly as a
message does, and says that it has. No new delivery path: the existing one is
the only one that respects a turn.

## Steps

1. `utils/session-snapshot.ts` and its tests.
2. `utils/now-render.ts` — the card, tested like the other renderers.
3. The Gemma call, its prompt, and its failure being harmless.
4. The command, the button, the edit-in-place.
5. CHANGELOG.

## Risks

- **A snapshot that lies is worse than none.** Every field says where it came
  from; anything not in the record is absent rather than guessed.
- **The model saying something confident and wrong.** Two lines, under the
  facts, visibly separated — and absent when the model is down.

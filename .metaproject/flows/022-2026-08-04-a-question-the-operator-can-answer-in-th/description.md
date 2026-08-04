# A question the operator can answer in their own words

Status: ready
Source: operator choice, 2026-08-04

## Problem

Only questions with ready-made options reach Telegram. `parseHookInput`
declines the whole tool call otherwise, and the terminal asks instead — which
the operator cannot see. That is the same failure the question feature was
built to fix, arriving from the other side.

The rule is all-or-nothing on purpose, and rightly so: answering two of three
questions denies the *whole* call, so the third would silently disappear. The
fix is therefore not to skip the unrepresentable question but to make it
representable.

It bites hardest exactly when it matters most. A question worth asking is often
one where none of the offered options is right — and that is precisely the
question that stays in the terminal.

## Expected Outcome

- Every question carries a way to answer in free text, whatever its options.
- The operator's next message becomes that answer, and is not forwarded to
  Claude as an ordinary message.
- A free-text answer reaches Claude as the operator's own words.

## Out of Scope

- Multi-select. It needs toggling and a submit, which is its own flow.
- Changing the all-or-nothing rule.

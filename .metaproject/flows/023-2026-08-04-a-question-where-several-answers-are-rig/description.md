# A question where several answers are right

Status: ready
Source: operator choice, 2026-08-04

## Problem

`parseHookInput` declines the whole tool call when any question is a
multi-select, and the terminal asks instead — where the operator cannot see it.
Free-text answers closed half of this gap; this is the other half.

The reason it was declined is honest and still true: one tap is one answer, and
a multi-select needs a way to say "these two, and now I am done". Without a
submit there is no moment at which the answer is final, and the existing
machinery treats the first tap as the answer.

## Expected Outcome

- A multi-select question shows its options as toggles and a way to submit.
- Toggling shows what is currently chosen, and nothing is recorded as final
  until the operator submits.
- Several chosen options reach Claude as several answers, not as one.
- Submitting nothing is refused rather than sent as an empty answer.

## Out of Scope

- Changing single-select behaviour. One tap stays one answer.
- The free-text button, which already works and stays on every question.

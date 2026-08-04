# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A multi-select question is accepted by the hook rather than declining the whole call.
- AC2: Its options render as toggles showing which are currently chosen, plus a submit.
- AC3: Tapping an option adds it; tapping it again removes it.
- AC4: Two taps on the same question compose — neither overwrites the other's selection.
- AC5: A multi-select question is not answered until submitted, however many options are toggled.
- AC6: Submitting with nothing chosen is refused and the question keeps waiting.
- AC7: Several chosen options reach Claude as several answers to that question, distinguishable from one.
- AC8: Single-select questions are unchanged: one tap is still one answer, with no submit.
- AC9: A multi-select callback and a single-select callback cannot be mistaken for one another.
- AC10: Every new test was checked by reintroducing the bug it covers, and each one failed.
- AC11: Full gate green: bun test, typecheck, eslint 0 errors, dupes unchanged.

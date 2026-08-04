# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every question message carries a free-text button in addition to its options.
- AC2: The free-text callback is distinguishable from an option callback, and neither parses as the other.
- AC3: Pressing it records which question is awaiting text, and a second press replaces the first rather than queueing.
- AC4: A message arriving while a question awaits text becomes that answer and is not forwarded to Claude as an ordinary message.
- AC5: A message arriving with nothing awaiting text is forwarded exactly as before.
- AC6: A free-text answer reaches Claude as the operator's own words, marked as typed rather than chosen.
- AC7: A question answered in free text counts as answered for completeness.
- AC8: An empty or whitespace-only message is not accepted as an answer, and the question keeps waiting.
- AC9: A free-text answer on an expired or already-answered request is refused, and the operator is told.
- AC10: Every new test was checked by reintroducing the bug it covers, and each one failed.
- AC11: Full gate green: bun test, typecheck, eslint 0 errors, dupes unchanged.

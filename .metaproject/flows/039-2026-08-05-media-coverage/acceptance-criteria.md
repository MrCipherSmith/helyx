# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A file delivered to a CLI session is queued with its attachment and its message id, and no model is called; proved by test.
- AC2: An image delivered to a standalone chat is inlined into the prompt and the answer is streamed back; proved by test asserting the image reached the request.
- AC3: A non-image delivered to a standalone chat is acknowledged rather than inlined; proved by test.
- AC4: An image that cannot be inlined degrades to the acknowledgement rather than failing silently; proved by test.
- AC5: The module doubles are installed per test and restored after, and the whole suite is run to prove nothing leaked.
- AC6: No production behaviour changes except the export made for the tests, carrying the comment saying so.
- AC7: `bot/media.ts` line coverage is measured before and after and both figures are recorded.
- AC8: Whole unit suite green and `tsc --noEmit` clean.
- AC9: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC10: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

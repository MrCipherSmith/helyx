# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: An image under the inline limit is sent inline; one over it is sent as a path, and the boundary itself is asserted on both sides.
- AC2: A file that is not an image is never inlined, whatever its size.
- AC3: An image is recognised by its mime type or, failing that, by its description — the second is what a photo from Telegram arrives with.
- AC4: A missing mime type does not make an image into a file, nor a file into an image.
- AC5: The caption and host path travel with every attachment shape.
- AC6: parseDaysArg returns the default for an empty, non-numeric or negative argument, and never a value the database would read as a window ending before it starts.
- AC7: parseDaysArg caps at the maximum and keeps a valid value unchanged, asserted at the boundary.
- AC8: Percentages are correct, and a total of zero produces no division by zero.
- AC9: A histogram bar is proportional to the largest row and never longer than its width.
- AC10: Every new test was checked by reintroducing the bug it covers, and each one failed.
- AC11: Full gate green: bun test, typecheck, eslint 0 errors, dupes unchanged.

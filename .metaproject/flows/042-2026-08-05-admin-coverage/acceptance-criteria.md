# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A handler that reports pending permissions says so when there are none, and lists them when there are; both proved by test.
- AC2: A handler that reports system status reports the database as unreachable rather than throwing when the query fails; proved by test.
- AC3: At least two more reporting handlers are driven against rows and against emptiness, and neither divides by zero nor throws.
- AC4: The context double records what was replied, so the assertions are about what the operator would read.
- AC5: The database replacement is installed per test and restored after, and the whole suite is run to prove it did not leak into other files.
- AC6: No production behaviour changes except a defect this flow finds, named as such.
- AC7: `bot/commands/admin.ts` line coverage is measured before and after and both figures are recorded.
- AC8: Whole unit suite green and `tsc --noEmit` clean.
- AC9: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC10: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

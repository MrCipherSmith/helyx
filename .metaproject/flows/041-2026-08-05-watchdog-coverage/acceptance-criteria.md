# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The permission-prompt detector is tested for a prompt it must catch, for the tool name it extracts, and for ordinary output mentioning permission that it must not fire on.
- AC2: The spinner, editor, credential and crash detectors are each tested for a positive case and for a near-miss that must not fire.
- AC3: The alert cooldown allows the first alert, suppresses a repeat inside the window, and allows one again after it.
- AC4: `fetchActiveSessions` maps rows into sessions, and returns an empty list rather than throwing when the query fails.
- AC5: Nothing in production changes except exports made for the tests, each carrying the comment saying so.
- AC6: `scripts/tmux-watchdog.ts` line coverage is measured before and after and both figures are recorded.
- AC7: Whole unit suite green and `tsc --noEmit` clean.
- AC8: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC9: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

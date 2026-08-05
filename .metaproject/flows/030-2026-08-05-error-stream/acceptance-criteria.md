# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `parseLogEntry` reads a real pino line from `logs/bot.log` into level, time and msg, and returns null for a line that is not JSON or carries no `msg`; proved by test using lines copied verbatim from the file.
- AC2: One message crossing the error threshold inside the window produces exactly one alert, and further occurrences inside the window produce none; proved by test.
- AC3: An error-level message never seen before alerts on its first occurrence, below any threshold; proved by test.
- AC4: A message already seen does not alert again on novelty; proved by test.
- AC5: Occurrences older than the window stop counting, so a slow trickle under the rate never reaches the volume threshold; proved by test.
- AC6: Warnings use their own, higher threshold and never trigger the novelty rule — 4136 identical warnings alert, one new warning does not; proved by test.
- AC7: The alert names the message, the count and the window, and carries the first occurrence time; asserted on the alert object, not on rendered text.
- AC8: `checkErrorStream` reports its own inability to read the log rather than failing silently, and a second consecutive failure raises one alert; proved by test with a failing reader.
- AC9: The loop reads incrementally: a second pass over an unchanged file produces no alerts, and lines appended between passes are seen exactly once; proved by test.
- AC10: Loop 9 is registered in `startSupervisor` and its timer is `unref`'d like every other loop there — the module has no `clearInterval` anywhere, and unreffing is what keeps a timer from holding the daemon open; verified by reading the registration beside its neighbours.
- AC11: Whole unit suite green and `tsc --noEmit` clean.
- AC12: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC13: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A fresh install that enables the dashboard writes `WITH_DASHBOARD=true` as well as `ENABLE_DASHBOARD=true`, proved by test.
- AC2: A fresh install that disables it writes both as false, proved by test.
- AC3: The readiness decision is a pure function, tested over all four combinations of the two flags and both empty and populated dist directories.
- AC4: The message names the flag to set and the command to run, proved by test — a message that says only "empty" costs the reader the same search every time.
- AC5: A bot that is told to serve a dashboard it does not have logs it once at startup, proved by test.
- AC6: A request to `/webapp/` on such a bot is answered with that explanation rather than falling through to the catch-all 404, proved by test.
- AC7: A correctly built bot is unaffected: no extra log, no changed response, proved by test.
- AC8: The Mini App menu button is not set when the dashboard is unavailable, proved by test.
- AC9: The readiness answer is computed once rather than per request, proved by test.
- AC10: No test in this flow reads the real image, container or `.env`.
- AC11: Whole unit suite green, `tsc --noEmit` clean, and the change recorded in `CHANGELOG.md`.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

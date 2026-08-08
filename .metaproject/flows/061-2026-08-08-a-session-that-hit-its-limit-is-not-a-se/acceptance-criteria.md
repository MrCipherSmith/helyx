# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `parseApiError` recognises an entry by `isApiErrorMessage === true` and returns the kind and, where the text carries one, the reset time; it returns null for any entry without that flag, including an assistant message quoting the same words.
- AC2: The five error texts observed in this project's transcripts are each classified as their own kind — session limit, weekly limit, overload, prompt too long, lost connection — and an unrecognised text is reported as an error of unknown kind rather than dropped.
- AC3: A limit event in a session's transcript produces exactly one alert in the supervisor topic, naming the limit and its reset time, however many times the transcript is polled afterwards.
- AC4: While a session is under a limit, `checkHungSessions` reports it as limited rather than hung and offers no restart button.
- AC5: A limit marker stops being believed once its stated reset time has passed, and within a bounded time when no reset time was given, so it cannot suppress hang detection indefinitely.
- AC6: A session with no row in `active_status_messages` — one driven entirely from the tmux pane — can be reported as hung, with staleness measured from a real activity signal.
- AC7: Widening the hung query does not change the verdict for sessions that were already covered: an existing test set for those cases passes unchanged, and each newly reachable case has a test of its own.
- AC8: Nothing in this flow acts on a limit automatically — no provider switch, no restart, no pause — and the fold marker from flow 059 keeps working alongside the new one.
- AC9: `bun run lint`, `bun run typecheck` and `bun test tests/unit/` all pass, and CI is green on the pull request.

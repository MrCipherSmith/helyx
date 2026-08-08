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
- AC4: While a session is under a limit, `checkHungSessions` holds its own alarm and offers no restart button. It does not send a second message — AC3's single alert is the only one the operator gets — so "reports it as limited" here means the hang alarm stands down and says why in the log, not that a second alert is raised.
- AC5: A limit marker stops being believed once its stated reset time has passed, and within a bounded time when no reset time was given, so it cannot suppress hang detection indefinitely.
- AC6: A session with no row in `active_status_messages` — one driven entirely from the tmux pane — can be reported as hung, with staleness measured from a real activity signal.
- AC7: Widening the hung query does not change the verdict for sessions that were already covered: an existing test set for those cases passes unchanged, and each newly reachable case has a test of its own.
- AC8: Nothing in this flow acts on the *session* automatically — no provider switch, no restart, no interrupt — and the fold marker from flow 059 keeps working alongside the new one. Holding queued delivery (AC16) is not an exception to this: it defers a message the way the poller already defers one mid-turn, and never touches the session or its process.
- AC9: `bun run lint`, `bun run typecheck` and `bun test tests/unit/` all pass, and CI is green on the pull request.
- AC10: The supervisor posts a periodic pulse covering every active session that is working, one line per session, carrying the project, input and output tokens, how long the current work has been running, context used against its window, and a short line saying what the session is doing.
- AC11: A session that is idle rather than working is not in the pulse, and a pulse with nothing to report is not sent at all.
- AC12: The pulse line is built from numbers that move: two consecutive pulses reporting identical figures for a session is itself reported as a session that has stopped progressing, distinct from both a hang and a limit.
- AC13: The pulse costs no new polling — it is assembled from the transcript reads and session rows the existing loops already perform.
- AC14: The supervisor's session list names the provider and the model each active session is running on, beside the state it already shows.
- AC15: A session whose project has no provider or model recorded says so as the default it actually uses, not as a blank or a dash — the line is there to answer "what is this session running on", and an empty answer is the one case where it fails.
- AC16: While a session is under a limit, queued messages for it are held rather than delivered, by the same deferral the poller already applies to a chat that is mid-turn.
- AC17: When the limit's reset time passes, the held messages are delivered without anyone typing anything — a session that was waiting resumes on its own.
- AC18: A message held for a limit is not counted as a stuck queue, so the operator is told "waiting for the limit to lift at 5:30pm", never "the queue is stuck" or "the session is hung".

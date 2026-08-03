# Flow Journal

- 2026-08-03T21:57:55.986Z - flow created
- 2026-08-03T21:57:56.090Z - task-added: T5: isOurContainer and parseContainerLine
- 2026-08-03T21:57:56.184Z - task-added: T6: broadcast onto docker ps -a with the scope
- 2026-08-03T21:57:56.280Z - task-added: T7: escape the status text
- 2026-08-03T21:57:56.367Z - task-added: T8: sql.json in the fixture
- 2026-08-03T21:57:56.453Z - task-added: T9: tests and full gate
- 2026-08-03T21:57:56.536Z - frozen: 10 criteria; checksum recorded
- 2026-08-03T21:57:56.623Z - started

## What happened

The container scope was never a coverage question. It was a decision nobody had
made, and while it was open the safe move was to keep listing only running
containers — which is precisely the blind spot that let a crash loop report
green for weeks. Once the maintainer answered it, the fix was four lines and a
predicate.

Worth naming: `docker ps` versus `docker ps -a` is not a flag preference. Under
`ps`, a crashed container is *absent*, and absence is what a healthy host looks
like. The alert could not fire because the evidence was not in the room.

### Two defects in my own tests, both found by running them

The healthy-container test asserted on the last `sendMessage` and found nothing.
The loop keeps one status message and edits it in place while everything is
healthy — silently, so a five-minute heartbeat does not notify — and only sends
afresh when there is a problem. Asserting only on sends misses every healthy
broadcast after the first.

And `updateProcessHealth` recorded no query at all. `sql.json` is a postgres.js
helper called while *building* the template arguments, so a fake without it
throws before the query is issued — and the query then never appears in the
recording, which reads as "the code did not run that statement". Two test files
had already added it by hand. It is in the fixture now, which is the same rule
this programme keeps rediscovering: the second hand-rolled copy is the signal.

### Numbers

`scripts/supervisor.ts`: 32.07% → 46.76% of lines, 54.55% → 62.26% of
functions. Tests 935 → 953.
- 2026-08-03T21:58:20.621Z - task-done: T1: Collect remaining context
- 2026-08-03T21:58:20.710Z - task-done: T2: Implement per plan
- 2026-08-03T21:58:20.798Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T21:58:20.886Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T21:58:20.980Z - task-done: T5: isOurContainer and parseContainerLine
- 2026-08-03T21:58:21.072Z - task-done: T6: broadcast onto docker ps -a with the scope
- 2026-08-03T21:58:21.159Z - task-done: T7: escape the status text
- 2026-08-03T21:58:21.248Z - task-done: T8: sql.json in the fixture
- 2026-08-03T21:58:21.337Z - task-done: T9: tests and full gate
- 2026-08-03T21:58:21.423Z - ac-confirmed: AC1: helyx-bot-1, helyx-postgres-1, carlson-bot-web-1 accepted; nginx, deprecated-postgres, my-helyx-experiment, helyxor-1 rejected
- 2026-08-03T21:58:21.513Z - ac-confirmed: AC2: name and status read; a daemon error line, an empty line and a half line are all null
- 2026-08-03T21:58:21.602Z - ac-confirmed: AC3: the command is asserted to contain docker ps -a
- 2026-08-03T21:58:21.690Z - ac-confirmed: AC4: Exited reported red, Up healthy green, via classifyContainer
- 2026-08-03T21:58:21.780Z - ac-confirmed: AC5: deprecated-postgres and nginx absent from the report; a project container present when the project is known
- 2026-08-03T21:58:21.869Z - ac-confirmed: AC6: a status containing <weird> arrives escaped
- 2026-08-03T21:58:21.959Z - ac-confirmed: AC7: an empty listing still produces a report rather than silence
- 2026-08-03T21:58:22.047Z - ac-confirmed: AC8: broadcastText reads the last send or edit — the loop edits in place while healthy
- 2026-08-03T21:58:22.137Z - ac-confirmed: AC9: FakeSql.sql.json added; ask-question-service.test.ts no longer defines its own
- 2026-08-03T21:58:22.231Z - ac-confirmed: AC10: typecheck clean, lint 0 errors, 953 tests, dupes 1, supervisor 46.76% lines

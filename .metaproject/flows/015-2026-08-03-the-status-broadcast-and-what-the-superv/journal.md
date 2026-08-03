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

## Review: three majors, and the first one would have made the feature useless

**The project name was a literal.** `COMPOSE_PROJECT` defaulted to `"helyx"`,
but compose derives its default from the directory it runs in. An installation
anywhere else produces `my-bot-*` containers, none of which the predicate
recognises — the listing comes back fine, nothing in it is ours, and an empty
set of owned containers is exactly what a healthy one looks like. The feature
would have worked on this machine and silently watched nothing everywhere else.
Derived from the directory now, the way compose does it.

**A name prefix does not prove ownership.** A project registered as `api` would
have adopted an unrelated `api-worker-1` — and `docker ps -a` now lists stopped
foreign containers, so the surface is larger than it was. The listing carries
`com.docker.compose.project` as its first field now and ownership is decided by
that label, exactly. A container started outside compose is matched by its exact
name, which is the only other thing that can be checked.

**And the tests could not tell silence from an alert.** The broadcast keeps one
message and edits it in place while healthy — deliberately, because a
five-minute heartbeat that notifies is a heartbeat the operator mutes. A problem
must therefore *not* be an edit, or it arrives with the same silence as good
news. `broadcastText` accepted either, so a regression that quietly edited a red
status would have passed. There is a controlled sequence now: healthy edits and
sends nothing; a problem deletes and sends and never edits.

That third finding also produced a real one. A readable listing containing
nothing of ours now raises the alarm rather than passing as health — the exact
failure the scope introduces, and the one the first finding would have caused.

Tests 953 → 957.

### The duplicate count is 2 now, and deliberately

`bun run dupes` reports the character class `[^a-z0-9_-]` in two places: Docker's
rule for a compose project name, and tmux's rule for a window name. They are
identical today because the two systems happen to agree — and they are owned by
different systems. Sharing them would mean that widening one silently widens the
other. Both sites carry a comment saying so; the replacement character differs,
which is the visible half of the difference.

The baseline moves from 1 to 2, both reviewed, the same way the `unquote` idiom
was accepted. The detector's own output says a duplicate is a question rather
than a verdict; this is the answer to it, written where the next reader looks.

Also restored: the `parseContainerLine` tests, which a bulk edit swallowed while
rewriting the block above them. Caught because lint reported the import as
unused — which is the only reason it was noticed at all, and worth remembering
about bulk edits.
- 2026-08-03T22:15:03.347Z - ac-confirmed: AC1: ownership decided by com.docker.compose.project exactly; an unlabelled container matched by exact name; api-worker-1 not adopted by a project called api
- 2026-08-03T22:15:03.438Z - ac-confirmed: AC5: foreign containers absent; a readable listing with none of ours raises the alarm rather than passing as health
- 2026-08-03T22:15:03.529Z - ac-confirmed: AC10: typecheck clean, lint 0 errors, 961 tests, dupes 2 both documented, supervisor 46.76% lines

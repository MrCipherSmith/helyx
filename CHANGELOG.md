# Changelog

## Unreleased

### feat: the status survives the reply that did not finish the work

Reported by the operator: an agent replies "запускаю сабагентов" and the topic
goes silent for minutes while it works.

The status message was deleted the moment a reply was sent. `channel/tools.ts`
carried a comment saying this was handled — that `schedulePostReplyCheck` would
notice post-reply activity and open a continuation — and **nothing ever called
that method**. Its only trace in the repository was the comment promising it
would run. Meanwhile the monitor kept running, kept calling `updateStatus`, and
`updateStatus` returned early whenever no status was open, so every line of
post-reply work arrived and was dropped on the floor.

Now: a reply closes the step with the summary it always wrote, and the first
thing the session does afterwards opens the status again. Silence closes it —
`CONTINUATION_IDLE_MS`, re-armed by every line — because a status opened after
a reply cannot wait for another reply to end it.

Three details that are not obvious and each cost something:

- A continuation does not make the chat busy. `getBusyChats()` is what holds
  the operator's next message back until a turn ends; a continuation is the
  tail of a turn that has already answered, and reporting it busy would have
  traded one silence for another.
- A status is not re-opened while the operator has a message waiting. The
  poller is about to open one for the next turn, and two would fight.
- The status moves to the bottom when something lands after it. Pinned means
  findable, not visible; three replies later it is off the screen. Bound to the
  landing, never to the edit — a move is a delete plus a send, and the edits run
  every few seconds.

The decisions — re-open, close, move — are three pure functions in
`utils/status-continuation.ts`, because each is a question about elapsed time
and forty-five seconds is not a test. `schedulePostReplyCheck` and the comment
that promised it are deleted.

Not yet visible during a subagent fan-out: a subagent writes to its own
transcript, which nothing reads. That is the next flow.

### test: what the MCP door says when it says yes

Flow 036 made the router in `mcp/server.ts` reachable and pinned its refusals,
then stopped and said why: everything past a refusal writes to Postgres or
starts background work. So the door was proved to say no correctly and nothing
at all was proved about it saying yes — and the maintainer's answer to that was
that there should be no dead ends left.

`McpDeps` and `setMcpDeps` are the seam, the fifth of its shape in this
repository after `MediaDeps`, `RunShell`, `TurnSummaryDeps` and
`scheduledReviewDeps`. It carries `sql`, `summarizeOnDisconnect`,
`sessionManager.register`, `pushExpect`, `extractFactsFromTranscript`,
`deliverTurnSummary`, `runQuestionExchange`, and the hook token — which is read
once at module load from a file on the host and had no other way in.

Sixteen tests, over the yeses and over the error exits, because a dead end
would be in the exits: `/health` connected and 503, the probe the host-ingress
daemon arms on; `/api/summarize` accepted and handed on, refused without a
session, and answering rather than throwing on a body that is not JSON;
`/api/sessions/register` registered under the name given and under the
directory's basename when none was, refused without a path, and reporting a
failing session manager as 500 instead of hanging; `/api/sessions/expect`
accepting a numeric id, refusing a string one — channel.ts sends it from a
shell, where everything is a string — and recording a relative project path as
none; `/api/hooks/stop` answering before its background work and handing both
jobs the same paths; `/api/hooks/ask-question` returning the operator's answer
as the hook's decision and 204 when there is none, which is the contract the
terminal depends on.

Line coverage 23.98% → 46.76%.

### feat: a reply carries what it was replying to

Every handler read `message.text` and nothing else, so `reply_to_message` and
`quote` were dropped at the door. The operator would select a few words out of
an answer, ask "а тут как?", and the session received four words with no
subject — the pointing gesture arrived without the thing pointed at.

- `utils/reply-context.ts` extracts both fields and renders them as a block.
  A hand-picked fragment leads and the message it came from follows it: the
  fragment is the act of pointing, and re-quoting the whole message first
  would bury it. Text is capped at 1200 characters and a fragment at 800, so
  a reply to a long answer does not re-inject the whole of it every time.
- Stored in a `message_queue.reply_context` column (migration v49) rather than
  inside `content`. The status line, the short-term memory and the skill hints
  all read the stored content; a quote pasted into it would have shown up as
  the question being worked on. The block is composed at delivery instead,
  beside the other channel notes.
- Carried on every path: connected session, restarting session, standalone,
  photos, documents and voice notes. A file that arrives without a caption
  keeps the reply from the file's own message, not from the sentence typed
  after it.
- The `forum_topic_created` service message Telegram attaches to a topic's
  first post is not treated as a reply — it would have quoted "topic created"
  at the session on every new topic.
### fix: the bot's own reactions no longer log as intruders

The bot reacts 👀 to every message it queues, and Telegram reports that back
as an update whose actor is the bot itself. It is not in `ALLOWED_USERS`, so
it fell through to the access warning and wrote an `access denied` line after
every single operator message. Dropped the same way, without the alarm.


## v1.54.0

### fix: the host door could not see past the first hundred updates

Found by review before this branch was committed, in `scripts/host-ingress.ts`.
A read without an offset returns the *oldest* hundred unconfirmed updates and
never advances on its own, so an outage noisy enough to bury the operator's
`/up` under a hundred messages would have hidden it for ever — silently, in the
one situation the door exists for. The window is now confirmed through its end
when it comes back full and holds nothing for the door, which trades the
stranded chat history for the recovery. A backlog that fits, or one that
carried a command, still costs the operator nothing.

Round two of the same review caught the fix's own bug: once the command was in
`seen`, the next re-read found nothing to do and confirmed the window anyway —
the door would have executed the operator's `/up` and then thrown away the
messages that arrived with it. A window is now judged by what it *held*, not by
what was left to do in it. A read that lands after the bot comes back is
dropped too, since the bot owns the token from that moment and would replay the
same command.

Also in `channel/status.ts`: `lastEditAt` was stamped after the edit returned,
while the comment beside it promised the start of the request. A Telegram call
that spent thirteen seconds in the client's retry loop was charged the throttle
floor a second time — the compounding the comment says it exists to prevent.

### test: the door every MCP call and every hook enters by

`mcp/server.ts` was 8.49% covered — 701 uncovered lines, eighth-largest gap in
the repository — and it could not have been covered. Its router was an
anonymous arrow inside `createServer`, reachable only through
`startMcpHttpServer`, which binds a fixed port (held on this host by the running
container) and can call `process.exit(1)` on the way in.

The router is now `handleMcpRequest(req, res, bot)`, exported. The change is a
move: same body, same route order, one parameter for the `bot` the arrow used to
close over — `transports` was already module-level. It matches the shape of
`handleDashboardRequest` in `mcp/dashboard-api.ts`, which this same function
calls and which flow 040 tests the same way. `isLocalRequest` is exported too.

Covered, and only this: the refusals. Who counts as local, across the whole
172.16–31 bridge range and the IPv4-mapped loopback form; the MCP endpoint
refusing anything outside it, which is the entire boundary in front of every
tool call since no JWT can guard a route the CLI must reach; a session-less GET;
the Stop hook refused from off the machine, refused without its fields, and
refused a transcript path that resolves out of where transcripts live —
`/home/../etc/passwd` is still a string beginning with `/home`; the
ask-question hook refusing a local caller with the wrong shared secret and with
none; and summarization refusing a caller that is neither local nor
authenticated.

The paths that succeed write rows and start summarization in the background.
Reaching them from a unit test would mean reaching the real database, so they
are left for a seam of their own and named here rather than implied.

Line coverage 8.49% → 23.98%. This is the sixteenth and last flow of the
observability programme, and the one that was blocked on a maintainer decision.

### test: what happens to a file after it has been downloaded

`bot/media.ts` was 5.59% covered — 405 uncovered lines — and it is how every
picture, voice note, document and video reaches a session. Its fork in the road
is `deliverMedia`: a file goes either into a CLI session's queue, as a message
carrying an attachment, or into a standalone chat, where an image is inlined
into the prompt and anything else is acknowledged.

That branch has been wrong in a way that mattered. A document arriving as
`image/png` was inlined for one path and not for the other, and one of the two
had no size limit at all, so a forty-megabyte picture went into a request whole.
The decision about *what* may be inlined was extracted to
`utils/media-attachment.ts` and tested there; the code that acts on the answer
was not tested anywhere.

Covered: a picture queued for a session with its base64 and its message id; an
over-large picture queued as a path instead, which is the guard the forty
megabytes walked past; a video queued as a file without its bytes ever being
read; an image inlined into a standalone prompt as an image block of the right
media type; a document acknowledged rather than inlined; an image too large to
inline degrading to the acknowledgement instead of vanishing; and a non-
Anthropic provider getting the acknowledgement rather than a request it cannot
answer. Line coverage 5.59% → 26.76%.

`deliverMedia` now reaches its collaborators through a `MediaDeps` seam
(`setMediaDeps`, which returns the function that puts them back). That is a
production change and it was not the first choice: replacing `memory/db.ts`
through the module registry re-evaluates the graph behind `bot/media.ts` —
which is most of the bot — and left `services/provider-service.ts`
half-initialised for four tests in `reviewer-service.test.ts` and one migration
test that had nothing to do with media. Nine replaced modules and then five
both did it. What a test does to the module registry outlives the test, so the
seam is the honest way in.

### test: the operator's console, against a database that answers and one that does not

`bot/commands/admin.ts` was 3.65% covered. Its handlers are the ones a person
reaches for when something is already wrong, which is the worst possible moment
for one of them to answer with an exception instead of a number.

Covered: pending permissions when there are none and when there are, with how
long each has waited; system status reporting the database as unreachable
rather than throwing — the case an operator hits precisely because something is
broken; permission statistics over a week with no requests, where a percentage
of zero gets written; and the statistics handler showing the typing indicator
before it starts reading.

The database is replaced per test and restored afterwards, never at module
scope: a top-level `mock.module` in this repository leaked into five tests in
other files earlier today, and the containment is the whole difference.

One note kept in the test rather than smoothed away: the first version left the
statistics summary query returning no rows, and the handler threw. That query is
a plain aggregate with no `GROUP BY`, so Postgres always returns exactly one row
— the fake was lying about the world, not the code failing. The row is now
programmed and the reason is written down.

Coverage of the file: 3.65% → 21.46%.

### test: what the watchdog concludes from a terminal

`scripts/tmux-watchdog.ts` reads every session's pane and decides from the text
on it whether to wake the operator — a permission prompt waiting for an answer,
a session stuck in an editor, a credential prompt, a crash. 470 of its 500 lines
were uncovered.

Those decisions are pattern matches over a terminal, the most brittle input in
the system, and this file has been wrong before: a stripper that made a working
session look hung, classifiers that fired on any mention of the word
"permission", a pane parser that failed silently on un-stripped ANSI. A regex
that stops matching costs an operator a session that waits for ever; one that
matches too much costs a notification on every message. Both failures are
silent.

Each detector is now driven over text shaped like the pane it really reads and,
as importantly, over the near-miss it must not fire on: output that merely
mentions permission, a spinner too far up the scroll-back to be current, a
sentence about vim rather than vim itself, a clean exit rather than a crash.
The alert cooldown is tested per kind, and reading the active sessions is tested
including the case where the query fails and the watchdog must keep running
rather than stop watching everything.

One test was written wrong and is kept as written: the development-channel
dialog needs both the warning and the confirmation line, because the warning
alone scrolls past on every start.

Coverage of the file: 6.00% → 18.89%. The remainder is the poll loop, which
shells out to tmux on every iteration.

### test: the two guards in front of the dashboard API

`mcp/dashboard-api.ts` is the largest untested file in the repository — 947
uncovered lines — and the only surface in the system reachable from a browser.
Its dispatcher carries the two decisions that matter before any data is
touched: a JWT check on everything under `/api/`, and an Origin check on
anything that changes state. Neither was tested, so a change that let one
through would have been invisible until somebody noticed data leaving.

Unlike `mcp/server.ts`, none of this needed a port or a refactor:
`handleDashboardRequest` is already a named function taking a request, a
response and a URL.

Covered: a request matching nothing is handed back to the caller, while a
dashboard asset is this dispatcher's own — the first version of that test
assumed the opposite and failing it is how the real contract came to light; no
credentials is 401; a genuine token, signed by the module that verifies it, is
let through in either form, cookie or `Authorization: Bearer`; a malformed
token and one signed with the wrong key are both no token; a state-changing
request from a foreign origin is refused even with a valid token, the same
request from its own host is not, and a GET is not subject to the check at all.

The guards are probed through a route no handler claims, so the tests ask only
what the guards did. The first attempt replaced the database module instead, so
a real handler could run against a fake `sql` — that mock is process-wide and
leaked into five tests in other files.

Coverage of the file: 3.66% → 18.25%. The remainder is the data routes, each of
which needs its own rows programmed; the guards were the part a regression
would have let through silently.

### test: the voice fallback that production has been relying on all day

Every reply over 300 characters is spoken, so `utils/tts.ts` runs on nearly
every message the operator receives — and it has been failing its first provider
on every one of them. `tts: Yandex error` with a 401 appears on each synthesis
in `logs/bot.log`: the key is rejected, the chain falls through to Piper, and
the operator hears the second provider without anything saying so. That fallback
was load-bearing in production and had never been tested. 529 of 560 lines
uncovered.

`synthesize` reaches the world through exactly two doors — `fetch` for the HTTP
providers and the normalizer, `Bun.spawn` for Piper — so both are replaced and
the decisions are driven without a network or a voice model. The Piper stub
reads the output path out of the argv it is given and writes a file there,
because a stub that only reported an exit code would prove the binary was
called rather than that sound came back.

Covered: nothing worth speaking and voice switched off; the chain with Yandex
answering, with Yandex failing into Piper — the path production takes on every
message today — with both failing into the third provider, and with all of them
failing, which is silence rather than a crash; the language order, where English
never asks the Russian-first provider; the guard that discards a normalizer
which answered in the wrong language, written because one once turned
`--build bot` into `--строить бот`; and that whatever Latin the normalizer
leaves is cyrillized before it reaches a voice with no Latin phonemes.

Then the decisions around it: which replies are spoken at all — a reply that is
mostly a fenced code block is not, a diff is not, and a markdown bullet list is
not mistaken for one — where a long reply is cut, and that a rejected upload is
swallowed rather than thrown at a caller whose text has already been delivered.

Coverage of the file: 5.54% → 57.02%.

### fix: a model that answers with nothing no longer becomes the session's record

`memory/summarizer.ts` decides what the system remembers, and 322 of its 390
lines were uncovered. It is also where defect D1 of this programme lived: for
weeks it resolved a host path inside a container, logged `file not found` 4136
times and saved nothing, and a person reading the log by accident was the only
thing that noticed.

Covering it found a second one of the same shape. `summarizeWork` guards its
model call with a timeout and falls back to the raw conversation when the call
throws — but an answer of `""` is not a throw. A model replying with nothing
therefore produced an empty `project_context`: a whole work session recorded as
an empty string, saved without complaint. An empty answer is now treated as no
answer, and the fallback that already existed does its job.

The tests drive the real decisions with the collaborators replaced at the module
boundary — the summarizer takes `sql`, the model client and both memory layers
as imports rather than as parameters, so that is where the doubles go. A `fetch`
stub was the obvious alternative and is worse: the client picks its transport
from the environment, so the stub would cover whichever one the machine happens
to use.

What is covered: too little to summarize, a summary the triage rejects, facts
written as facts beside the summary and a fact too short to keep, project
knowledge with and without a project path, the work-session close including the
fallback above, and the idle timer's lifecycle — set, replaced, cleared —
because a timer left behind summarizes a session that has already ended.

Coverage of the file: 17.44% → 77.67%.

### test: the supervisor's loop inventory is now asserted

`scripts/supervisor.ts` is the highest-risk file in the repository by the
project's own measure — churn × complexity 355 776, first by a wide margin — and
it gained three loops in one day while half of it was untested.

The largest single gap was `startSupervisor` itself: 179 uncovered lines whose
whole content is the inventory — which loops exist, how often each runs, and
whether each holds the daemon open. A loop written and never registered is a
monitor that exists in the source and not in the process, which is exactly the
outage Loop 8 was added to catch, and nothing would have caught it happening
again.

- The inventory is read back by replacing `setInterval` and `setTimeout` for the
  duration of the test: eleven loops, their intervals, their offsets, and that
  every timer is unref'd — the whole of the shutdown story in this module, since
  it has no `clearInterval` anywhere.
- `formatSnapshotForGemma` is tested against the shape the analyst receives,
  including that no section vanishes when its list is empty. A section that
  disappears is a problem the model is structurally unable to see.
- `callGemmaForHealth` and `getLlmExplanation` are tested for what they do when
  the network says no: both degrade rather than throw, because an analyst that
  crashes the loop it runs in is worse than one that says nothing.
- `checkGemmaHealth` and the scheduled review's wiring are driven with a fake
  database and a stubbed transport.

One defect found and fixed on the way: the startup line announcing what is
running listed seven loops while eleven were registered — a log that
under-reports the system is the same quiet untruth this supervisor exists to
catch.

Coverage of the file: 52.03% → **75.60%**, measured on this branch alone in a
git worktree. The same run against the working tree reads 73.66%, because the
tree carries another session's uncommitted loop, which has no tests and is not
part of this change — worth stating rather than quoting whichever number
flatters the result.

### fix: the quality gate stopped judging by a stale number

Three untruths, measured on 2026-08-05.

The gate imported `coverage/coverage-summary.json` and nothing regenerated it,
so every run since 2026-08-04 judged the project on that file. Regenerating it
moved the reading from 30.13% to 36.25%: four days of work invisible to the
thing that exists to see it.

`tests` reported `missing` while 1540 tests passed. Not a broken configuration —
health wants a project-scope report, and the newest artifact is normally written
by the post-commit hook, which runs a *changed*-scope selection. It was reading
the wrong run, not no run.

And the figures this programme had published were estimates. Uncovered counts
were derived from file length × uncovered fraction; lcov has exact ones and they
differ by hundreds of lines per file. The earlier headline of 47.90% was Bun's
text-reporter aggregate over loaded files, where the lcov record — the one the
gate imports — answers 36.25%. The gap to the floor is larger than was
published, not smaller.

- `bun run health` runs coverage, then a project-scope test report, then the
  gate. The order was the defect, so the fix is a sequence with a name.
- `scripts/coverage-summary.ts` is the bridge the whole reading rests on and had
  no test. It now has one, including the arithmetic that matters: totals are
  summed across files, never per-file percentages averaged, which would let a
  covered three-line file cancel a thousand uncovered ones.
- `docs/requirements/io-layer-coverage-2026-08-05` carries the exact figures and
  states the correction rather than quietly replacing the numbers.
- The 2026-08-03 programme note, which still called the coverage work blocked on
  a fixture that has existed for days, is superseded through
  `keryx memory supersede`.

### feat: a review that starts itself

Nothing started one. `scripts/review.ts` ran when a person typed it, and
`.git/hooks/pre-push` runs the security guard and nothing else — so the moment a
review is most valuable, a branch that has stopped changing, is exactly the
moment attention has moved on.

Loop 11 checks every fifteen minutes and runs the pipeline when the current
branch's diff has changed and then stayed still for one pass. Two identical
hashes is what "settled" means, and at that interval it is a quarter of an hour
of quiet — the difference between reviewing a branch and chasing one mid-edit.
The default branch is never reviewed: a merge has already happened and a review
of it is archaeology.

Deliberately not a git hook. `REVIEW_TIMEOUT_MS` is ten minutes; a `pre-push`
that can hold a push for that long is disabled within a week, and then nothing
runs at all. This observes the work instead of standing in front of it — it
writes an artifact and posts one message, and it cannot block a push, a commit
or a container.

The decision is a pure function with a named reason for every answer, so the
rules are testable without a repository, a database or a reviewer. State lives
in `bot_config`, because the supervisor restarts often and in-memory state would
re-review on every restart; the in-flight flag is cleared even when a review
throws, or the loop would never run again.

### fix: a reviewer that cannot review no longer reads as available

Three failures of one thing, all of them live and all of them measured on
2026-08-05.

The question was wrong. `getReviewerStatuses` asked Codex `codex login status`,
which answered `Logged in using ChatGPT` while every `codex exec` was refused
with `You've hit your usage limit … try again at Aug 11th, 2026`. `/reviewers`
would have shown a green tick for six days against a reviewer that could not
review.

Nobody asked it. The only caller was the `/reviewers` command, so a dead
reviewer announced itself inside the review you had just asked for.

And the failure was misfiled. `classifyCodexFailure` matched
`rate limit|quota|too many requests`; Codex says **usage limit**, which is none
of them, so every round that day recorded `failed (exit 1)` — true, and
useless.

- The classifier learns Codex's own wording, and carries the reset time through:
  `limit until aug 11th, 2026 5:49 pm` rather than an exit code.
- Availability is answered by evidence. `lastOutcomeByReviewer` reads what each
  reviewer actually did in the newest run artifact, and a reviewer whose last
  real run failed is unavailable whatever its login says.
- `ReviewerStatus` gains `probed`. A backend with no probe and no recorded run
  is a third state — `/reviewers` renders it ⚪ — rather than a green tick
  meaning "nobody asked".
- Loop 10 checks every 30 minutes and alerts on **transitions**: a reviewer down
  for six days is one alert, not two hundred and eighty-eight. A balance below
  the floor counts as down, and re-arms only above floor plus margin so a
  balance at the line does not alternate.

### feat: a review leaves something behind

`scripts/review.ts` ran every reviewer, printed the reports to a terminal and
exited. The structure it discarded would have serialized directly, and the
receiver for it already existed — `keryx memory ingest --from-review <path>` is
in the memory module's CLI surface and nothing here had ever produced a file
for it.

What that cost, repeatedly and recently: a second review of a branch cannot
know what the first said. One flow in this programme went three rounds, and
nothing but a chat log records what rounds one and two claimed or which of it
turned out to be wrong.

Every run now writes `logs/reviews/<stamp>-<branch>/run.json` and `report.md`.
Truncation is recorded as a flag rather than left inside an error string, an
unavailable reviewer is part of the record rather than omitted, and a run in
which every reviewer failed is kept too — it is the case where nobody read the
change. Artifacts are pruned by age and count, except the newest run of each
branch, which is exactly the review nobody can reconstruct from memory.

The console contract is unchanged and now testable: `reviewConsoleLines` holds
the shape `CLAUDE.md` depends on, including the bare `SELF` line, and the
artifact path goes to stderr so nothing reading stdout can be confused by it.
Persistence happens after printing and cannot fail the review: an unwritable
directory warns and returns null.

One measurement worth writing down: fed the first artifact to
`keryx memory ingest --from-review`, it exits 0 and creates a "lesson" per
heading line — eleven of them out of an eight-line header. The sender existing
was only half the problem; the two formats have never met, and aligning them
belongs to whoever owns the ingester.

### feat: something reads what the bot says about itself

The supervisor runs ten scheduled checks. They read Docker, `message_queue`,
`sessions`, `active_status_messages` and `process_health`. None of them read
`logs/bot.log`, and on 2026-08-05 three separate repeating defects were live in
one day of it — a voice pipeline failing its first provider on every message, a
fact extractor logging `file not found` 4136 times, and the bot's own reactions
logging as an access violation. All three were found by a person reading the
file while looking for something else.

Loop 9 reads what has been appended since its last pass and applies two rules,
each of which exists because the other cannot see its case:

- **Volume** — one message crossing a threshold inside a rolling window. This is
  the 4136 case: nothing new about any of them, and nobody told.
- **Novelty** — an error-level message not seen before, reported on its first
  occurrence whatever the count. This is the leak that never gets loud enough
  for a threshold, and it is what would have caught the Yandex 401 on the day it
  started rather than weeks later.

Having been reported as new does not exempt a message from later being reported
as a flood: "this error exists" and "it is now constant" are different
sentences and the operator is owed both.

Reading is incremental through `TranscriptTail`, the reader written for the
status monitor, which already handles a line whose newline has not arrived yet
and a file that was truncated or replaced. The window is in memory and resets
with the daemon: an alert about errors that stopped an hour ago is noise, and
the file remains the record.

The watcher reports its own blindness. Two consecutive failures to read the log
raise one alert of their own — a monitor that stops working quietly is the
defect this loop exists to remove, and it is not allowed to become one.

### fix: one answer to which containers exist

The supervisor asked Docker twice. `sendStatusBroadcast` ran `docker ps -a`,
with a comment explaining that without `-a` a crashed container does not appear
as broken — it vanishes, and a vanished container is indistinguishable from one
that was never there. `collectSystemSnapshot`, thirty lines away and feeding the
health analyst every ten minutes, still ran `docker ps`: the analyst was asked
to judge system health from a list that structurally could not contain a dead
container, and, having no ownership filter either, from one that could contain
somebody else's.

The fix is not the missing flag. Two call sites answering one question with two
commands is what let them drift, so the question moved: `listOwnedContainers` in
`utils/supervisor-status.ts` runs the command, applies the ownership rule and
classifies each container, and the two consumers now differ only in how they
render it — coloured lines in HTML for the operator, plain text for the analyst.
`RunShell` moved there with it rather than being declared in both files.

One behaviour change beyond the flag: an unreadable listing reaches the analyst
as `unavailable` instead of as `no containers`. A dead daemon and an empty host
are not the same state, and the broadcast has distinguished them since the flow
that made the red state reachable at all.

### fix: the transcript the hook reports, and the one the bot can open

A Claude Code session runs on the host and its Stop hook posts
`/home/<user>/.claude/projects/<slug>/<id>.jsonl`. The bot reads that report
from inside a container, where the same directory is mounted at
`HOST_CLAUDE_CONFIG` and `/home/<user>` does not exist. Both consumers took the
path literally, so neither had ever worked in a container deployment.

- `extractFactsFromTranscript` logged `file not found` and returned — 4136
  times in the current `logs/bot.log`. Not one fact has been extracted from a
  transcript since the hook was wired up.
- `deliverTurnSummary` threw on the read and returned. Its failures are silent
  by design — "a courtesy at the end of work that already succeeded" — so it
  left no trace of never having run at all.

`localTranscriptPath` in `utils/transcript-locate.ts` re-roots a host path at
whatever `claudeConfigRoot()` resolves to, carrying only the segment after
`/.claude/` and rejecting one that contains `..`: the incoming path was
validated by the caller and the derived one is not validated again. The
session-end extractor falls back to the existing `resolveTranscript` scan, which
matches on the `cwd` each transcript declares; the per-turn summary gets the
cheap translation only, and attempts it just once, after a real read failure —
on the host the first read succeeds and nothing else runs.

### fix: a deleted forum topic stopped being an invisible failure

The keryx topic was deleted from the client, and nothing in the system noticed.
Telegram does not reject a send into a deleted topic — it accepts the message,
drops the thread and files it in General — so the project's `forum_topic_id`
stayed live in the database while every answer went to the hub, without one
error line to say so.

- `validateTopicExists` probed with `sendChatAction`, which Telegram answers
  `ok` for a thread id that never existed — confirmed against `999999`. Every
  topic validated, so `/forum_clean` reported "all valid" and could never clean
  the one case it exists for. It now sends a real probe and reads the answer
  Telegram gives honestly: a live topic echoes `message_thread_id` back, a
  deleted one does not. The probe is deleted either way, including when it
  lands in General.
- Every channel send goes through `telegramRequest`, so that is where the miss
  is caught: a reply that asked for a thread and came back without it (or with
  a different one) now logs at error level naming the topic and where the
  message actually landed. The send still reports success — Telegram delivered
  it, and failing it would make the channel resend a message that exists.

## v1.54.0

### fix: the installer was shipping a three-month-old checkout

`install.sh` resolves its version from the GitHub API's `releases/latest`,
and releases had stopped at v1.47.0 on 2 May while six tags shipped past it.
Every `curl … | bash` from the README cloned v1.47.0 and then pulled the
`:latest` image built from v1.53.0 — current image on May sources and a May
`docker-compose.yml`.

- Releases now exist for v1.48.0, v1.49.0, v1.52.0 and v1.53.0, created in
  ascending order with the latest pointer set explicitly, so the API answers
  with the tag that was actually released.
- No source change: the defect was entirely in what the repository had
  published about itself.

### fix: name the bot image instead of deriving it from the directory

The `bot` service had no `image:` key, so Compose derived the name from the
project — which is the install directory. The default `~/helyx` produces
`helyx-bot` and matches what `install.sh` tags after pulling;
`HELYX_DIR=~/my-bot`, which the README documents, produces `my-bot-bot` and
silently discards the 1.3 GB just downloaded in favour of the local build the
pull existed to avoid. `HELYX_IMAGE` overrides the name.

### fix: clear the 36 dashboard eslint errors

Held back in v1.53.0 because they are react-hooks correctness rules that need
the UI exercised rather than reasoned about. Both apps were driven end to end
in a browser against the live API for this change — the dashboard across all
nine routes, the Mini App across every tab.

- `Date.now()` out of render behind a `useNow` hook (three sites); the
  latest-ref write in `useEventStream` moved into an effect.
- Four fetch effects no longer set state synchronously, and each carries a
  `cancelled` guard — which also closes a real bug where a slow response for
  a previous session or filter could land on top of a newer one.
- 18 `any` replaced: `errorMessage()` for `catch (e: any)`, stale
  `(api as any)` casts dropped, `window.onTelegramAuth` declared.
- `main.tsx` no longer defines the component it mounts, restoring fast
  refresh. Two unused bindings removed.
- Health score 37 → 57, findings 301 → 265.

### docs: changelog and roadmap catch up

The changelog had stopped at v1.46.0 while README's "Recent Changes" pointed
readers straight at it; v1.47.0 through v1.53.0 are now written up. The
roadmap's Planned section claimed `.github/workflows/e2e.yml` was committed
and waiting on three repository secrets — that file was deleted in `5bab380`,
and the entry now describes the decision the work actually needs.

## v1.53.0

### fix: keep tmux alive across admin-daemon restarts

Restarting `helyx-admin` killed every CLI pane. The tmux server inherited
the service cgroup, so systemd's control-group kill took the whole session
down with it, and Telegram messages piled up in `message_queue` with
nothing left to consume them.

- tmux server now starts in its own transient systemd scope
  (`helyx-tmux.scope`), outside the service's control group.
- `helyx up` matches window names exactly. The prefix-resolving
  `has-session -t sess:name` matched `goodai` against the existing
  `goodai-base` window, so that project was never started.
- `helyx up` moved from `ExecStartPre` to `ExecStartPost` — running it
  first spawned a second admin-daemon before systemd started its own.
- The stuck-queue restart button passes `projectId`, not `sessionId`;
  `enqueueRestart` threw "project not found" on every click.

### feat: eslint pass — the required signal health thought was running

`keryx health` listed eslint as a required source and had been reporting
it "skipped": there was no config and no lint script, so score 87 rested
on complexity alone.

- Flat config with js + typescript-eslint recommended. Four deliberate
  severity choices: `no-explicit-any` warns (213 exist), `no-empty` allows
  an empty catch (how this codebase says "best effort, never fatal"),
  `no-control-regex` off (the bot parses tmux panes and ANSI output),
  `no-useless-escape` warns (removing the backslash in
  `[a-zA-Z0-9._\-\/~^:]` turns the path-traversal guard into a
  SyntaxError).
- Errors outside `dashboard/` went 57 → 0. Two defects the pass surfaced
  are fixed: `supervisor.ts` captured the tmux pane in `checkStuckQueue`
  and never put it in the alert, and `channel/status.ts` matched
  `[·●⏳🔄⎿]` without the `u` flag, so the surrogate-pair emoji matched
  half-characters.
- The dashboard keeps 36 errors from its own nested config, nearly all
  react-hooks correctness rules. They stay visible rather than silenced —
  changing them safely needs the UI exercised.

### feat: wire tests and coverage into the quality gate

Health had six sources configured and was reading two. Tests read
"missing" and coverage read "missing", so a project with 284 passing tests
scored as though it had none.

- `keryx test run` normalizes the project's own runner. This matters: the
  built-in fallback runs a bare `bun test`, which would pull in the
  Playwright e2e suite.
- `scripts/coverage-summary.ts` bridges Bun's text/lcov output to the
  Istanbul `coverage-summary.json` health reads — lines.pct per file plus
  a total, not a pretend Istanbul report. `test:coverage` produces it.
- First honest reading: 15.71% line coverage over the 74 files the unit
  tests touch, against a soft floor of 60. Gate is WARN on coverage
  rather than FAIL on a regression that was really just the lights coming
  on; the baseline was re-recorded, since the old one was taken while four
  of six sources were silent.

### refactor: split registerTools into one function per tool family

`registerTools` was a single ~750-line function and the most complex thing
in the codebase — cyclomatic 145, in a file that is also the fourth-highest
hotspot by churn × complexity.

- `TOOL_DEFINITIONS` becomes a module constant; the list never depended on
  session state, yet it was rebuilt on every ListTools request.
- Case bodies move verbatim into `handleTelegramTool`, `handleMemoryTool`,
  `handleSkillTool` and `handleCuratorTool`. Each returns `null` for a name
  it does not own, so the dispatcher chains them and falls back to the same
  "Unknown tool" text the default case produced.
- `channel/tools.ts` drops from cyclomatic 145 to 80.

### chore: metaproject re-init on keryx 345eaa5

Modules 8 → 9 with `security` joining (scanning, redaction, guardrails,
audit; advisory mode, so the pre-push guard warns and never blocks).
`keryx update` could not have added it — its backfill is written for the
`tasks` module only, so a workspace initialized before `security` existed
would have skipped it silently, forever. Graph, wiki, testing context and
health artifacts refreshed in the same pass.

## v1.52.0

### feat: per-project provider and model switching

`/providers` registers an Anthropic-compatible endpoint (GLM / Kimi /
DeepSeek / OpenRouter presets, or Custom); `/projects` → ⚙️ picks provider,
then model, and restarts that project. A project with nothing configured
behaves exactly as it did before the feature existed. See
`docs/providers.md`.

- Security-critical launch fix: `run-cli.sh` unsets `ANTHROPIC_API_KEY`
  before launching a third-party provider. helyx `.env` sets that key and
  `run-cli.sh` loads it with "only if unset" semantics, so without the
  unset a project `.env` cannot override it and the real Anthropic key is
  sent to the third-party endpoint.
- Providers are asked for their own model list, refreshed on demand; the
  Anthropic default list is refreshed from the Claude session. A ~320-model
  OpenRouter list no longer bursts Telegram's 4096-char limit — truncated
  and sorted free-models-first.

### feat: verbatim replies with a separate spoken recap

The Telegram message is the model's text unchanged. A summarized recap
(≥ 200 prose chars) is generated only for voice and collapsed behind a
show-more blockquote.

### fix: guard no longer eats the question; commands stop stranding steps

- When the response guard gives up on a turn, the unanswered question is
  put back in the queue instead of dropped.
- Issuing a slash command mid-flow cancels the input step that was
  waiting; pending scopes moved from chat-level to `chat_id:thread_id`, so
  forum topics stop interfering with each other.
- Fixes: the OpenRouter preset pointed at the wrong protocol;
  `/providers` and `/projects` registered for group chats; the Stop hook is
  no longer registered from ephemeral checkouts.

## v1.51.0

### feat: deployment profiles and prebuilt images

- `HELYX_PROFILE` = `minimal` | `local` | `full`; the `minimal` wizard asks
  five questions instead of roughly fifteen.
- Dashboard gated at build time and runtime via `ENABLE_DASHBOARD`. The
  default is deliberately asymmetric: an `.env` written before the flag
  keeps its dashboard, and only a fresh install writes `false`.
- `.github/workflows/publish.yml` publishes prebuilt images on GHCR and
  `install.sh` pulls instead of building locally.
- Unattended install path: `helyx setup --profile=minimal … < /dev/null`
  completes with stdin closed; setup refuses to overwrite a live `.env`
  without `--force` and never touches running services unattended.

### fix: image layering — 3.13 GB → 1.27 GB

A single `chown -R` was creating a 905 MB layer. The dashboard's real cost
turned out to be build *memory*, not bytes: a dashboard-off build completes
under a 256 MB / 2 CPU builder where the full build OOM'd at 512 MB.

Also in this release: five requirement packages that had shipped more than
they claimed were re-verified against the code and restated. The one
deviation found — tmux log path hardcoded instead of derived from
`BOT_DIR` — was fixed.

## v1.50.0

### feat: session context injection

On CLI restart, the first delivered message includes a prior-context block
(LLM summary, with raw messages as fallback). The guard key
`sessionId:clientId` resets on every new Claude Code process. Fail-open:
DB errors are logged and skipped.

### fix: restart control reform

- `checkHungSessions` and `checkStuckQueue` no longer auto-restart; both
  use the unified dedup key `session_problem:<project>`, and alerts include
  the pane tail and spinner detection.
- `enqueueRestart()` is the single idempotent entry point for all
  `proj_start` commands; a double-press returns "⏳ уже в очереди".
- `forwardStuckMessages` is callable per-project from the supervisor-actions
  callback `sup:force_deliver`.
- Alerts auto-resolve: the message is edited to ✅ after two consecutive
  clean ticks (60 s) and the inline keyboard is cleared.
- `run-cli.sh` restart cap escalates to Telegram after
  `MAX_RESTARTS_IN_WINDOW` (default 3) restarts in `RESTART_WINDOW_SECONDS`
  (default 300 s), writes a marker file and exits the loop.
- tmux audit daemon (`scripts/tmux-session-logger.ts`): structured JSONL
  log of session/window lifecycle events, periodic snapshots, `--query` CLI
  for post-mortem, started by `admin-daemon`.

## v1.49.0

### feat: supervisor overhaul

- Smart status broadcast — edits the message in place (silent) when
  healthy; delete + send (notification) only when a stuck queue or a 🔴
  docker container is detected.
- Stuck-queue auto-recovery — `checkStuckQueue` triggers `proj_start`
  before alerting; manual buttons appear only if auto-recovery fails.
- `/supervisor` command — on-demand status from anywhere, not just the
  supervisor topic.
- Acknowledge button — "🔕 Тишина 30м" on all alerts; the ack is stored in
  `admin_commands` and the supervisor checks the DB each loop, staying
  silent for the window.
- Escalation — after 30 min of repeated failures, hung channel processes
  are killed (`pkill bun channel.ts`) before `proj_start`, and a
  "🚀 Bounce бот" button is added on failure.

## v1.48.0

### feat: send_photo MCP tool

New tool on both stdio and HTTP transports; supports a public URL and a
local file via multipart upload, with forum-topic routing in the stdio
transport.

### feat: status intelligence

- Smart response guard — 3-state Claude activity detection: silent re-arm
  (< 90 s), soft note (long thinking), alert + delete status (stuck).
  Replaces the single generic "no reply" message.
- Status heartbeat — one 15 s interval replaces the separate 1 s spinner
  and 10 s pane timers; each new user request starts with a clean status
  message (delete → send instead of edit-in-place).

## v1.47.0

### feat: public release

The repository is open-sourced: personal references scrubbed from code,
changelog and UI strings, and `/quickstart` translated to English.

- Generated developer docs (`docs/dev/`) — onboarding, architecture,
  modules, API reference, data models, via the autodoc pipeline.
- Release materials (`docs/release/v1.47.0/`) — press releases, developer
  and user descriptions, platform posts (EN + RU).

### fix: fail-closed admin check and graceful degradation

- `isAdmin()` is fail-closed: `/system` and admin callbacks deny access
  when `TELEGRAM_CHAT_ID` is not configured (previously fail-open).
- `recall()` degrades gracefully when Ollama is unreachable —
  `embedSafe()` returns null instead of throwing, recall falls back to
  recency sort, and `remember()` proceeds without an embedding, so no data
  is lost.
- `admin-daemon` processes commands sequentially: `LIMIT 1` with
  `FOR UPDATE SKIP LOCKED` instead of concurrent `setImmediate` dispatch,
  eliminating out-of-order execution.
- `setMyCommands` runs in both webhook and polling modes; previously bot
  commands were only registered on the webhook path.
- Menu dispatch errors surface as `⚠️ /cmd failed: reason` instead of a
  silent drop.
- The bounce path uses a portable bun binary —
  `Bun.which("bun") ?? process.execPath` replaces a hardcoded path.

## v1.46.0

### feat: /model fetches live model list from Anthropic API

`/model` now calls `GET /v1/models` on the Anthropic API and shows the actual
available models as inline buttons instead of a hardcoded list. Display names
come from the API (`display_name` field). Current model is marked with ✅.

### fix: /menu Back button — ignore "message is not modified" error

Telegram rejects `editMessageText` when the content hasn't changed (e.g. on
double-tap or duplicate webhook delivery). Added `ignoreNotModified` helper
so Back and group-nav taps are idempotent and never surface a GrammyError.

## v1.36.0

### feat: /menu — grouped command navigator + /system control panel

**`/menu` — two-level inline command navigator**

Replaces the flat 40-item Telegram command list with a grouped inline panel:
- Level 1: 8 category buttons (Session, Memory, Projects, System, Stats, Tools, Codex, Forum)
- Level 2: commands within the category as buttons — tap to run immediately
- Commands that require arguments (remember, recall, forget…) auto-prompt via existing handler logic
- ◀️ Back button returns to categories

Telegram command autocomplete (`/`) trimmed to 12 most-used commands; everything else accessible via `/menu`.

**`/system` — system control panel**

Inline panel for full system management from Telegram:
- ▶️ Start / 🛑 Stop tmux sessions
- 🔄 Bounce — full session restart (helyx bounce via admin-daemon, spawned detached so the daemon survives kill-session)
- 🐳 Restart bot — restarts the helyx-bot Docker container
- ⚡ Kill channels — kills all channel.ts MCP subprocesses so they respawn with updated code
- Admin-only (TELEGRAM_CHAT_ID guard)

**admin-daemon: new commands**
- `bounce` — runs `helyx bounce` detached
- `channel_kill` — `pkill -f "bun.*helyx/channel.ts"`

**fix: setMyCommands reliability**

Moved `setMyCommands` from `createBot()` to `main.ts` after `bot.init()` — previously it ran before auth was confirmed and silently failed on startup.

## v1.35.0

### feat: Skills Toolkit — Phase B / Skill Curator (#33)

Weekly cron job that reviews `agent_created_skills` and applies lifecycle
transitions: auto-pin frequently-used, auto-archive stale, queue
consolidate/patch for human approval. Uses an aux-LLM separate from the
main session so the Anthropic prompt cache stays untouched.

- New module: `utils/curator.ts` — selection, prompt building, action
  dispatch with markdown-fence-tolerant JSON parsing.
- New table: `curator_runs` (v26) — per-run timing, counts, cost.
- New table: `curator_pending_actions` (v27) — human-approval queue
  with 24 h expiry.
- `scripts/admin-daemon.ts` — cron registration + post-run Telegram
  summary; `lastCuratorRun` persisted via `MAX(curator_runs.started_at)`
  so a daemon restart inside the firing window does not double-fire.
- Telegram inline buttons `[Approve] / [Skip]` for consolidate/patch
  proposals (`bot/callbacks.ts`); auto-applied: pin, archive.
- New env: `HELYX_CURATOR_CRON`, `HELYX_CURATOR_PAUSED`,
  `HELYX_CURATOR_ARCHIVE_DAYS`, `HELYX_CURATOR_PIN_USE_COUNT`,
  `SUPERVISOR_CHAT_ID`, `SUPERVISOR_TOPIC_ID`.
- New prompt: `prompts/skill-curation.md` (was a TS constant).

## v1.34.0

### feat: Skills Toolkit — Phase C / Autonomous Skill Creator (#32)

After a multi-step success, the agent can distill the workflow into a
reusable SKILL.md via aux-LLM (DeepSeek default; Ollama / OpenRouter
fallback) and persist it to `agent_created_skills` in postgres. A
Telegram approval message gates the transition from `proposed` to
`active`; on `[Save]` the skill is materialized atomically to
`~/.claude/skills/agent-created/<name>/SKILL.md` so Claude Code's
native loader can find it.

- New modules: `utils/skill-distiller.ts`, `utils/aux-llm-client.ts`,
  `utils/skill-approval.ts`.
- New MCP tools: `propose_skill`, `save_skill`, `list_agent_skills`.
- New tables: `agent_created_skills` (v24), `aux_llm_invocations` (v25).
- Validator returns non-blocking warnings when the LLM-generated body
  contains `!\`cmd\`` tokens; warnings surface in the approval message.
- Telegram inline buttons `[Save] / [Reject] / [Edit name…]`
  (`bot/callbacks.ts`); rename uses the existing pending-input flow.
- New env: `HELYX_AUX_LLM_PROVIDER`, `HELYX_AUX_LLM_MODEL`,
  `DEEPSEEK_API_KEY`, `CUSTOM_OPENAI_BASE_URL`, `HELYX_OLLAMA_URL`.
- New prompt: `prompts/skill-distillation.md` (was a TS constant).

## v1.33.0

### feat: Skills Toolkit — Phase A / Inline Shell Expansion (#29)

Skills can now embed `!\`cmd\`` tokens that resolve to shell output at
load time, eliminating one tool-call round-trip per dynamic dependency.
A new `skill_view` MCP tool loads skills with inline shell
expansion, falling back to the native loader for skills without tokens.

- New module: `utils/skill-preprocessor.ts` — regex match + spawn +
  index-spliced replacement (handles duplicate identical tokens
  correctly) with explicit env allowlist (PATH/HOME/LANG only — no
  inheritance of `DEEPSEEK_API_KEY` / `DATABASE_URL` etc.).
- Sandbox: 5 s per-command timeout with SIGTERM → 500 ms grace →
  SIGKILL fallback; concurrent stdout/stderr drain so >64 KB outputs
  don't deadlock the pipe; 4096-char output cap.
- New module: `utils/skill-handlers.ts` — shared `skill_view` handler
  for both `channel/tools.ts` (host) and `mcp/tools.ts` (Docker), with
  skill-name validation guard against path traversal.
- New table: `skill_preprocess_log` (v23).
- New env: `HELYX_SHELL_TIMEOUT_MS`, `HELYX_SHELL_OUTPUT_CAP`.
- Demo skill: `skills/git-state/SKILL.md`.
- 19 new unit tests covering stateless detection, duplicate-token
  expansion, name validation, fast-path log policy.

## v1.32.6

### chore: remove kesha-voice-kit, simplify TTS/ASR chains

Kesha-voice-kit removed entirely. Real-world latency on x64 CPU was
30–60s per request even after v1.5 (Vosk-TTS) — Yandex SpeechKit
(2-4s for paragraph-length input) covers Russian, Piper/Kokoro cover
English, Groq covers ASR. Kesha was redundant in practice and
held the docker image at +1 GB for baked TTS models.

**TTS chain after**:
- Russian (auto): Yandex → Piper → Groq
- English (auto): Piper → Kokoro → Groq

**ASR chain after**: Groq → local Whisper (HTTP fallback)

**Changes**:
- `utils/tts.ts`: removed `synthesizeKesha`, `synthesizeCurrentOnly`,
  kesha branches in auto-mode dispatch.
- `utils/transcribe.ts`: removed `transcribeKesha`,
  `ensureKeshaModels`, kesha fallback branch.
- `utils/benchmark.ts`: deleted (was kesha-vs-current comparison).
- `bot/media.ts`, `channel/tools.ts`: removed benchmark wiring.
- `config.ts`, `.env.example`: removed `KESHA_*` env vars.
- `Dockerfile`: removed kesha-engine binary download (24 MB) +
  `kesha install` model bake (~990 MB) + `espeak-ng` dep.
- `docker-compose.yml`: removed `KESHA_BIN` env.
- `README.md`: provider chains simplified, env-vars table trimmed.
- `docs/requirements/kesha-voice-kit-2026-04-19/`: PRD deleted
  (preserved in git history at commit `8ce06d5`).

**Migration**: nothing to do for users with `KESHA_TTS_ENABLED=false`
(default). Users who had it on: voice quality is unchanged — Yandex
serves Russian, Piper/Kokoro serve English, both already in chain.

**Image size**: docker image drops by ~1 GB (~990 MB models +
24 MB binary + ~30 MB espeak-ng).

**Reversible**: `git revert <sha>` restores everything; the kesha
PRD lives at `8ce06d5^:docs/requirements/kesha-voice-kit-2026-04-19/`.

## v1.32.4

### feat: kesha-voice-kit v1.5 compatibility (Vosk-TTS for Russian)

Kesha v1.5.0 (2026-04-29) replaced Piper-RU with Vosk-TTS — multi-speaker,
BERT prosody, dictionary G2P. Pre-v1.5 voice IDs (`ru-denis`, `ru-irina`)
no longer resolve. The Russian quality user complaint from v1.32.0 is
the explicit motivation for the upstream change.

**Changes**:
- `config.ts`: new `KESHA_VOICE_RU` (default `ru-vosk-m02`) and
  `KESHA_VOICE_EN` (default `en-af_heart`). Operators who need a
  different speaker can override via env without code change.
  Available RU voices: `ru-vosk-{m01,m02,f01,f02,f03}`. macOS users
  can also use `macos-com.apple.voice.compact.ru-RU.Milena` for the
  zero-install AVSpeech path.
- `utils/tts.ts:synthesizeKesha`: voice ID now read from config
  (was hardcoded `"ru-denis"` / `"en-af_heart"`).
- `utils/tts.ts` (auto-routing comment): updated to reflect that
  Kesha's Russian quality is now competitive with Piper-RU under
  Vosk-TTS. Order preserved (Yandex → Piper → Kesha → Groq) for
  observable-behavior continuity; can flip Piper / Kesha later if
  Vosk-TTS proves consistently better in practice.
- `.env.example`: documented the new envs + the pre-v1.5 ID
  deprecation. Comment also points at `kesha install --tts` (~990 MB
  download for new models) and the `~/.cache/kesha/models/{g2p,piper-ru}`
  cleanup that operators upgrading from v1.4.x can run to reclaim
  ~700 MB.

**Operational steps for upgrade** (operator-side, not code):
```bash
bun add -g @drakulavich/kesha-voice-kit@latest
kesha install --tts                          # ~990 MB
rm -rf ~/.cache/kesha/models/{g2p,piper-ru}  # reclaim ~700 MB
```

Existing installs that don't upgrade kesha-engine will keep working —
helyx defaults `KESHA_VOICE_RU=ru-vosk-m02` which the pre-v1.5 engine
will reject as "unknown voice", logging a warning. The fallback chain
(Yandex → Piper → Groq) still produces audio, just without Kesha's
contribution. Operators can also pin the old engine + override
`KESHA_VOICE_RU=ru-denis` to keep current behavior.

151/151 unit tests pass.

## v1.32.3

### fix: review follow-ups (1 blocker + 1 major + 5 minor)

Closes 7 findings from the v1.32.2 review pass.

**[F-001] BLOCKER — migration v22 referenced `admin_commands.updated_at`** which
is not part of the v1.32.0 schema (added only in archived agent-runtime
migrations). On the live install the column happens to exist, but a fresh
clone of v1.32.x would have failed to migrate with `column "updated_at"
does not exist`. Migration v22 rewritten as three explicit `tx`-tagged
SQL blocks (one per table); `admin_commands` no longer touches a
non-existent column. Eliminates the table-list loop entirely.

**[F-002] MAJOR — `tx.unsafe()` with interpolated identifiers**: replaced by
three hardcoded `tx\`...\`` calls. No more pattern of "interpolate a
table name into unsafe SQL" that future contributors might copy into
untrusted contexts.

**[F-003] MINOR — `validateMigrationRegistry` check ordering**: integer +
positive check now runs FIRST. Previous order (dedup → monotonicity →
integer) silently let fractional values pass earlier loops because the
`<=` comparison in monotonicity is permissive on non-integers.

**[F-004] MINOR — backup-db.sh pg_dump stderr swallowed**: added `2>&1`
before the pipe so warnings land in the cron log file, not just on the
controlling terminal.

**[F-005] MINOR — backup-db.sh gzip integrity not verified**: added
`gzip -t` after the size check. Catches the partial-write case (disk
full mid-stream produces > 1 KB but corrupt archive that the size
check alone would let pass).

**[F-006] MINOR — backup-db.sh rotation glob unquoted**: quoted the full
path `"${BACKUP_DIR}/${DB_NAME}"_*.sql.gz`. Defends against env-var
overrides containing spaces.

**[F-007] MINOR — migration-registry tests re-implemented the validator**:
exported `validateMigrationRegistry(input?)` with default-arg
preservation of the production call site. Synthetic-bad-input tests
now call the real function via the new param. Drift between test
expectations and implementation is no longer possible.

### Tests

`tests/unit/migration-registry.test.ts`: synthetic-bad-input cases
now invoke the real validator; added a 4th case proving the
integer-first ordering produces the cleaner error path. 151/151
unit tests pass.

### Live verification

Backup script smoke: 212 KB dump, gzip-integrity OK, rotation honored.

## v1.32.2

### chore(migrations): validate registry on startup — reject dupes / non-monotonic / non-positive-int

Migration framework's `pending = filter(version > current)` logic
silently breaks if two migrations share a version (only one gets
recorded in `schema_versions`; the other is forgotten) or if versions
don't ascend monotonically.

`validateMigrationRegistry()` runs at the top of `migrate()`:
- duplicate version → throw with `[db] duplicate migration version: vN`
- non-strictly-ascending order → throw with `[db] non-monotonic migration order at index i: vX follows vY`
- non-integer or `< 1` → throw

`tests/unit/migration-registry.test.ts` (4 cases) re-derives versions
from `memory/db.ts` source via regex and asserts the same invariants
plus 3 synthetic-bad-input cases.

150/150 unit tests pass. Verified live: planting a duplicate v5 makes
`bun memory/db.ts` throw the expected error.

## v1.32.1

### fix: postgres.js v3 jsonb cast bug — silent scalar-string storage

Eight call sites in v1.32.0 used the broken `${JSON.stringify(x)}::jsonb`
pattern. postgres.js v3 silently strips trailing `::jsonb` casts on
parameter placeholders → values bound as TEXT → JSONB columns received
the string-literal form (`'"{\"k\":\"v\"}"'`) rather than the parsed
object. `jsonb_typeof()` reports `'string'` instead of `'object'`.

**Real symptom in production**: `services/project-service.ts` idempotency
check `(payload->>'project_id')::int = ${id}` returned NULL on the
scalar-string rows, so the check never found duplicates and the same
`proj_start` admin command could be enqueued multiple times for one
project. App-side reads were defended by `normalizeCLIConfig()` and
admin-daemon's `typeof === "string" ? JSON.parse : raw` so the bug
hid behind the JS layer.

**Sites fixed** (`${JSON.stringify(x)}::jsonb` → `${sql.json(x)}`):
- `sessions/manager.ts` — register `metadata`, `cli_config`;
  `updateCliConfig`
- `bot/commands/tmux-actions.ts` — admin_commands payload
- `bot/commands/interrupt.ts` — admin_commands payload
- `bot/commands/monitor.ts` — admin_commands docker_restart payload
- `mcp/dashboard-api.ts` — admin_commands docker_restart payload
- `services/project-service.ts` — admin_commands proj_start/stop payload

**Migration v22**: idempotent parse-back for `sessions.metadata`,
`sessions.cli_config`, `admin_commands.payload`. Updates rows where
`jsonb_typeof = 'string'` AND text starts with `"{` or `"[` (size
bounded 4 B – 1 MB). Re-running finds zero rows.

**Live DB application** (this install had legacy data from before the
fix): 66 `admin_commands.payload` rows reverted from scalar-string to
proper JSONB object via direct SQL since the runtime DB schema_versions
already exceeded v22 from prior agent-runtime work that has since been
archived.

**Test** (`tests/unit/jsonb-cast-v1.32.test.ts`, 3 cases):
- session register persists `metadata` + `cli_config` as JSONB objects
- `admin_commands.payload` lands as object with extractable `->>'key'`
- the project-service idempotency `(payload->>'project_id')::int = N`
  predicate matches a row inserted with the new code path

146/146 unit tests pass.

## v1.31.0

### fix: security hardening + concurrency correctness (full project review)

Comprehensive review of 58 files (4009 insertions since v1.24.0) produced 6 blockers
and 18 major findings — all fixed in this release.

**Security:**
- `handleMonitorCallback` now checks `TELEGRAM_CHAT_ID` before queuing Docker/daemon
  restarts — matches the guard already present in `handleSupervisorCallback`
- `scan_project_knowledge` MCP tool validates the target path is within
  `HOST_PROJECTS_DIR` / `HOME` to prevent path traversal
- `cli.ts` `helyx add` / `helyx remove`: allowlist regex validation + LIKE wildcard
  escaping (`%`, `_`, `\`) — `helyx remove %` no longer deletes all projects
- Dashboard restart buttons now require `window.confirm()` before firing
- Dashboard mutation errors (restart daemon / restart container) now surface to the
  user instead of being silently swallowed

**Concurrency:**
- All 5 supervisor `setInterval` loops now carry in-flight guards
  (`sessionCheckRunning`, `queueCheckRunning`, `voiceCheckRunning`,
  `broadcastRunning`, `idleCheckRunning`) — prevents overlapping executions that
  caused duplicate `proj_start` commands and duplicate Telegram alerts
- `tgPost` 429-retry now creates a fresh `AbortSignal.timeout(10_000)` instead of
  reusing the already-elapsed one from the first request — all retries actually fire
- `writeProcessHealth`: in-flight guard + `timeout 10 docker ps` to prevent DB pool
  starvation when Docker daemon is hung
- `admin-daemon` startup: reset `admin_commands` rows stuck at `status='processing'`
  (crash-recovery for commands lost between TX commit and `setImmediate` dispatch)

**Data integrity:**
- `checkIdleSessions`: `forceSummarize` return value checked before deleting messages
  — no more data loss when summary quality check skips trivial content
- `checkIdleSessions`: `deleteBefore` timestamp captured before `forceSummarize` call
  — messages arriving during the 30s Ollama call are not deleted
- `IDLE_COMPACT_MIN`: minimum bound `Math.max(10, ...)` prevents accidental compaction
  of all sessions when env var is empty or zero
- `voiceStatusId` race fixed: `INSERT INTO voice_status_messages` is now `await`-ed
  before `enqueueForTopic` — `clearVoiceStatus()` always has a valid ID; removed
  redundant explicit calls on early-return paths (only `finally` runs cleanup now)

**Correctness:**
- `updateDiff` recursive self-call on Telegram edit failure replaced with direct
  non-recursive `sendTelegramMessage` — eliminates stack overflow risk
- `diffMessages` key now includes `message_thread_id` via `diffKey(chatId, extra)` —
  prevents key collision across multiple forum topics sharing the same `chatId`
- `handleMonitor` refresh: `handleMonitor(ctx)` called before `deleteMessage()` so
  the old message stays intact if the new send fails
- `gemma4:e4b` hardcode replaced with
  `OLLAMA_CHAT_MODEL ?? SUMMARIZE_MODEL ?? "gemma4:e4b"` in both `supervisor.ts`
  and `supervisor-actions.ts` — no more 10s hang on installs without that model
- `sendStatusBroadcast` success log: `console.error` → `console.log`

---

## v1.30.0

### feat: Supervisor idle auto-compact + SUMMARIZE_MODEL + summary quality validation

- **feat(supervisor)**: idle session auto-compact after `IDLE_COMPACT_MIN` minutes
  (default 60) with ≥10 messages — calls `forceSummarize`, clears cache + DB
- **feat(memory)**: `SUMMARIZE_MODEL` env var — use local Ollama model for
  summarization (`SUMMARIZE_MODEL=gemma4:e4b`), falls back to main LLM on failure
- **feat(memory)**: summary quality validation before saving — rejects trivial
  summaries (`< 50 chars`, matches "nothing significant" patterns); pre-check skips
  summarization for sessions with avg message length < 25 chars
- **feat(setup)**: Ollama detection in setup wizard — prompts to configure
  `EMBEDDING_MODEL` and `SUMMARIZE_MODEL` when Ollama is available

---

## v1.29.0

### feat: Supervisor LLM diagnosis with Ollama + /status in supervisor topic

- **feat(supervisor)**: switched to `gemma4:e4b` via Ollama `/api/chat` with
  `think: false` (~3.2s vs 7.6s for thinking models)
- **feat(supervisor)**: any message in supervisor topic returns live status + LLM
  assessment of system health, scoped to Helyx monitoring context
- **feat(supervisor)**: recovery verification — polls `active_status_messages` for
  60s after `proj_start`; sends ✅ or ⛔ result; inline 🔄 retry button on failure
- **feat(supervisor)**: 5-minute status broadcast replaces hourly pulse — deletes
  previous message so new one triggers notification

---

## v1.28.0

### feat: Helyx Supervisor — automated session health monitoring

New `scripts/supervisor.ts` module integrated into `admin-daemon`:

- **Session watchdog**: checks `active_status_messages` every 60s — stale heartbeat
  (> 2 min) triggers `proj_start` via `admin_commands`
- **Queue watchdog**: stuck `message_queue` entries (> 5 min, `delivered=false`)
  surface as inline-button alerts (🔄 Restart / ✅ Ignore)
- **Voice cleanup**: `voice_status_messages` rows > 3 min edited to "bot restarted"
  warning + deleted from DB
- **LLM diagnosis**: every incident includes an Ollama explanation (best-effort,
  10s timeout, skipped gracefully when Ollama unavailable)
- **Telegram notifications**: all alerts → `SUPERVISOR_TOPIC_ID` with 429 retry
- **Idempotency**: 5-minute dedup window prevents duplicate alerts per incident

---

## v1.27.7

### fix(voice): track status messages in DB — recover stale "downloading..." on restart

When the bot restarted mid-download, the "🎤 Voice message — downloading..." Telegram
message was never updated, leaving it visually stuck forever. Fix:
- New `voice_status_messages` table: each in-flight voice download registers its
  Telegram status message ID.
- On bot startup, `recoverStaleVoiceStatusMessages` edits any rows older than 5 min to
  "⚠️ Bot restarted — voice message was not processed. Please resend."
- DB row is deleted via `finally {}` after the queue task completes (success or error).

### fix(voice): explicit file_path null check + error reason in status message

Telegram Bot API omits `file_path` for files >20 MB. Using `file.file_path!` (non-null
assertion) caused a silent TypeError crash. Fix throws a descriptive error
(`"File not accessible via Bot API, possibly >20 MB"`). Download failures now show the
actual reason in the Telegram status message instead of a generic "Failed to download".

### fix(voice): 30 s download timeout + queued/downloading status distinction

`downloadFile` had no timeout on the Telegram CDN fetch — a slow response blocked the
per-topic queue indefinitely. Added `AbortSignal.timeout(30_000)`. Status message now
shows "queued..." when the slot is occupied and updates to "downloading..." when the
task actually starts.

---

## v1.27.6

### fix(tmux-watchdog): auto-confirm dev-channel prompt in ALL windows, not just active sessions

Root cause of the "stuck at Enter to confirm" deadlock: `pollWindows()` only
checked windows with active sessions, but a session can only become active *after*
the startup prompt is confirmed — a circular dependency. Fix adds a global window
scan at the top of each poll cycle that sends Enter to any window showing the
`--dangerously-load-development-channels` warning, regardless of session state.

### fix(channel): heartbeat failure counter — exit after 2 consecutive DB errors

Previous code used `.catch(() => true)` on `renewLease()`, silently treating any
DB error as "lease still held". This meant a channel.ts process whose DB connection
died would keep running indefinitely, holding a zombie session. Fix tracks
consecutive failures; exits after 2 so the session is released and a fresh restart
can recover.

### fix(tts): return audio format from synthesize() — prevent MP3-as-WAV delivery

`synthesize()` previously returned `Buffer | null`; callers always sent
`audio/wav` / `voice.wav`. Yandex and OpenAI return MP3, so Telegram rejected the
audio. Fix changes the return type to `{ buf: Buffer; fmt: "mp3" | "wav" } | null`.
Each provider now tags its output format; `maybeAttachVoice` and `maybeAttachVoiceRaw`
use the correct MIME type and filename (`voice.mp3` vs `voice.wav`).

### fix(message_queue): deduplicate on restart — prevent double delivery after Docker restart

Root cause of duplicate responses after `docker compose up -d`: grammY's long-polling
re-delivers Telegram updates that weren't acknowledged before the process died. The
same message was inserted into `message_queue` twice (no uniqueness constraint), both
rows were dequeued and delivered to Claude, producing two replies.

Fix:
- Migration v19: partial unique index on `message_queue(chat_id, message_id)` excluding
  empty strings and `'tool'` entries.
- `bot/text-handler.ts` and `bot/media.ts`: INSERTs now use
  `ON CONFLICT ... DO NOTHING` so duplicate Telegram updates are silently dropped.

---

## v1.27.5

### fix(status): spinner animates at 1 fps instead of every 5 s

Status message edit interval reduced from 5 000 ms to 1 000 ms so the braille
spinner visibly rotates every second. The edit is cheap — pane snapshot and token
counters are already cached; only the spinner frame and elapsed counter change on
each tick.

---

## v1.27.4

### feat(bot): `/interrupt` command — interrupt running Claude session via Telegram

New `/interrupt` Telegram command (`bot/commands/interrupt.ts`):

- If one active remote session → interrupts immediately, no extra prompts.
- If multiple active sessions → shows inline keyboard with ⚡ button per session.
- Inserts `tmux_send_keys` + `esc` action into `admin_commands` queue.

### fix(admin-daemon): poll-based interrupt confirmation instead of fixed sleep

`tmux_send_keys` with `action: "esc"` now polls for the confirmation dialog
(`Enter to confirm / Esc to cancel`) in a loop (200 ms intervals, 1.5 s deadline)
instead of a fixed 800 ms sleep. Faster on quick machines, reliable on slow ones.
Result message distinguishes confirmed vs. Escape-only.

### feat(status): animated braille spinner with stale indicator

`channel/status.ts` now uses a 10-frame braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) instead
of a static ⏳ icon. If no `update_status` call arrives for >60 s, the spinner
shows ⚠️ to indicate the session may be stalled.

### fix(channel/tools): delete status after reply is sent

`reply` tool previously deleted the status message before sending the reply, so
the ✅ completion indicator briefly disappeared before the answer appeared.
Status is now deleted after the reply is confirmed sent.

### fix(run-cli.sh): faster and longer auto-confirm polling

Shell-side "development channels" warning auto-confirmer now polls every 0.5 s
(was 1 s) for up to 120 iterations (60 s, was 30 s). Comment updated to reflect
the actual behaviour.

### fix(tmux-watchdog): fallback dev-channel prompt auto-confirm

Added `detectDevChannelPrompt()` as a watchdog fallback for the startup
`--dangerously-load-development-channels` warning. If `run-cli.sh`'s shell-side
watcher races or times out, the watchdog silently sends Enter on the next poll
cycle. No Telegram notification is generated.

### fix(tmux-monitor): visible-only pane capture; normalize status for comparison

`captureTmux()` now captures only the current visible screen (no `-S` scrollback
lines), eliminating ghost detections from already-answered dialogs and stale tool
calls. `normalizeForComparison()` strips elapsed time and token counters before
diffing, preventing status updates from firing every 5 s just because the timer
incremented.

---

## v1.27.3

### fix(projects): idempotency — suppress duplicate start/stop commands

Double-clicking a project button or rapid retries no longer enqueues duplicate
commands. Both layers are guarded:

- **UI layer** (`bot/commands/projects.ts`): checks `getPendingActions()` before
  enqueuing; answers the callback with "Already starting/stopping…" if one is
  already in flight. Also suppresses the Telegram "message is not modified" error
  (content unchanged → no-op instead of delete-and-resend).
- **Service layer** (`services/project-service.ts`): `ProjectService.action()`
  now skips `INSERT` if a matching `pending`/`processing` row already exists.
  `listAll()` uses a `LATERAL` join to surface the most relevant session
  (active preferred, then most-recently-active).

### fix(admin-daemon): kill ALL matching tmux windows to prevent zombie accumulation

`tmux kill-window -t "bots:<name>"` only kills the first matching window — if
multiple windows share the same name (e.g. after a rapid restart), the extras
survive as zombies. Fixed by looping `kill-window` until none remain:

```bash
while tmux kill-window -t "bots:<name>" 2>/dev/null; do :; done
```

Applied to both the `start` path (before re-creating the window) and the `stop`
path. Stop command now prefers `project_id` over name for the session status update.

### fix(tmux-watchdog): visible-only pane capture for permission prompt detection

Permission prompt detection previously used `capturePane()` which includes
scroll-back history. If a dialog had already been answered and scrolled out of
view, the watchdog would re-detect it as active — causing spurious "still active"
false positives.

**Fix:** added `capturePaneVisible()` (no `-S`/`-E` range → current screen only)
and switched permission detection and polling to use it. Dialogs in scroll-back
are already answered and must not trigger re-detection.

Also added a 1 s delay before the first polling iteration so a very fast
auto-approval doesn't make the dialog disappear before the first check, which
previously caused an immediate false "Resolved in terminal" on the first tick.

### fix(tts): language guard after LLM normalization

`normalizeForSpeech` now receives `isRussian` and injects a `Language: Russian /
English. DO NOT translate. Output in <lang> only.` prefix into the user message,
reducing wrong-language normalization.

Additionally, a post-normalization guard checks whether the script ratio changed
(Cyrillic vs Latin). If the normalizer returned text in the wrong language despite
instructions, the bot falls back to the pre-normalization stripped text so the TTS
model always receives input in the correct language.

### feat(docker): Piper TTS directory mounted into container

`docker-compose.yml` now mounts `./piper` as a read-only volume at `/app/piper`
and passes `PIPER_DIR=/app/piper`. The `piper/` directory is added to `.gitignore`
(binary + voice models are not tracked in git).

---

## v1.27.2

### feat(setup): TTS configuration in setup wizard with Piper voice selection

Setup wizard now includes a full TTS configuration block:

- **Provider selection**: auto / Piper / Yandex SpeechKit / Kokoro / OpenAI / Groq / Disable
- **Piper voice multi-select**: choose languages to download (English required); voices downloaded automatically from HuggingFace
  - English: `en_US-lessac-medium` (male)
  - Russian: `ru_RU-irina-medium` (female), `ru_RU-denis-medium` (male)
  - German, Spanish, French available
- **Piper language-aware model selection**: `PIPER_MODEL_EN` / `PIPER_MODEL_RU` env vars; Piper now picks the right model per detected language
- **Yandex SpeechKit**: API key, Folder ID, voice (alena/filipp/jane/omazh/zahar), language
- **Kokoro**: dtype and voice selection
- **OpenAI**: API key

Also:
- `config.ts`: `TTS_PROVIDER` enum extended with `"piper"`, `"openai"`, `"groq"`, `"none"`
- `utils/tts.ts`: language-aware Piper model selection; English auto-mode now tries Piper first before Kokoro

Setup wizard (`bun cli.ts setup`) now includes a full TTS configuration block:

- **Provider selection**: auto / Piper / Yandex SpeechKit / Kokoro / OpenAI / Groq / Disable
- **Piper**: configure custom `PIPER_DIR` and voice model filename
- **Yandex SpeechKit**: API key, Folder ID, voice (alena/filipp/jane/omazh/zahar), language
- **Kokoro**: dtype (q4/q8/fp16/fp32) and voice selection
- **OpenAI**: API key

All settings are written to `.env` automatically.

Also:
- `config.ts`: `TTS_PROVIDER` enum extended with `"piper"`, `"openai"`, `"groq"`, `"none"`
- `utils/tts.ts`: `PIPER_MODEL` now configurable via `PIPER_MODEL` env var; added `none`/`openai`/`groq` provider handling

---

## v1.27.1

### fix(channel): prevent duplicate replies on Stop/Start restart

When a Claude Code process was killed between a successful Telegram send and the
`UPDATE pending_replies SET delivered_at = NOW()` call, the `deliverPendingReplies`
recovery on next startup would resend the already-delivered message — causing
duplicate replies.

**Fix:** `delivered_at` is now set *before* the Telegram send, not after. This
gives at-most-once delivery semantics: if the process dies mid-send, recovery
won't retry (the message may be lost), but it won't send duplicates.

### fix(status): less alarmist response guard message

The 5-minute "no reply" guard message was reworded to be less alarmist — Claude
might simply be running extended thinking, not crashed.

---

## v1.27.0

### Live pane snapshots for all sessions in split-pane mode

Tmux watchdog now captures terminal output for every active session, including
projects running as panes inside a shared tmux window (i.e. `helyx up -s`).

Previously only sessions that had their own dedicated tmux window received
`pane_snapshot` updates — in split-pane mode all projects share window 0
("helyx"), so the watchdog couldn't find them by window name.

**Fix:** watchdog now falls back to matching sessions by `project_path` against
`pane_current_path` from `tmux list-panes -a`. If no window matches by name,
the matching pane (e.g. `0.3`) is used as the tmux target for both pane capture
and permission-prompt interactions.

Also in this release:
- **fix(permissions):** expire all pending permission requests on bot startup
  (previously only requests older than 2 min were expired, leaving orphaned
  pending rows when the bot restarted quickly)
- **fix(callbacks):** `.catch(() => {})` on `answerCallbackQuery` /
  `editMessageText` to silence "query is too old" errors after restart

---

## v1.26.0

### DB as single source of truth for projects

`tmux-projects.json` is removed. The `projects` DB table is now the only registry.

- `helyx add` — writes to `projects` table via `psql` (same as `/project_add` in bot)
- `helyx up` / `helyx ps` / `helyx remove` — all read from DB
- `/project_add` in bot — unchanged, already wrote to DB
- Adding a project via bot now automatically shows up in `helyx up` without any manual JSON editing

This eliminates the dual-registry problem where projects added via `/project_add` (bot) were invisible to `helyx up` (CLI).

---

## v1.25.0

### Process Monitor — Dashboard & WebApp

Process health dashboard now available in both the web dashboard and the Telegram WebApp.

#### Web dashboard (`/monitor` page)

New sidebar page (Monitor → `Activity` icon) with three sections:
- **admin-daemon** — PID, uptime, stale heartbeat warning (>90 s), `🔄 Restart daemon` button
- **Docker containers** — per-container status from `docker ps`, `🔄 Restart bot` button for the bot container
- **tmux sessions** — active session count from DB

Auto-refreshes every 15 s; restart buttons optimistically queue `admin_commands` and re-poll after a brief delay.

#### Telegram WebApp (`🖥 Procs` tab)

New fifth tab in the WebApp bottom nav, styled with Telegram CSS variables. Shows the same three sections (admin-daemon, Docker, tmux sessions) with restart buttons. Available even when no session is selected (host-level view).

#### API

- `GET /api/process-health` — returns `process_health` rows + active session count
- `POST /api/process-health/restart-daemon` — queues `restart_admin_daemon` admin command
- `POST /api/process-health/restart-docker` — queues `docker_restart {container}` admin command

#### Files

- `dashboard/src/pages/Monitor.tsx` — new dashboard page
- `dashboard/webapp/src/components/ProcessHealth.tsx` — new WebApp component
- `mcp/dashboard-api.ts` — `handleGetProcessHealth`, `handleProcessAction` handlers
- `dashboard/src/api/client.ts` — `ProcessHealthRow`, `ProcessHealthResponse` types + API methods
- `dashboard/webapp/src/api.ts` — `processHealth`, `restartDaemon`, `restartDockerContainer` methods
- `dashboard/src/i18n.ts` — `nav.monitor` translations (EN/RU)

---

## v1.24.0

### tmux Watchdog — Session Health Monitoring & External MCP Permissions

Host-side watchdog that polls active Claude Code sessions every 5 s and routes problems to Telegram with actionable buttons.

#### Permission routing for external MCP tools

Claude Code's built-in `permission_request` channel only covers native tools (Bash, Edit, Read). External MCP tools (docker, github, etc.) show an interactive dialog in the terminal. The watchdog intercepts these and routes them to Telegram with the same **✅ Yes / ✅ Always / ❌ No** buttons. User response is fed back via `tmux send-keys`. The **Always** action writes the tool to `settings.local.json` for permanent auto-approval.

#### Stall detection

Detects when a session shows a spinner but `last_active` hasn't been updated for 2.5+ min — the definitive signal of a hung MCP transport. Alert includes **[⚡ Interrupt]** button that sends `Escape` + auto-confirms the interrupt prompt. Cooldown: 10 min.

#### Editor detection

Detects vim/nano opened in the pane (e.g. from `git commit` without `-m`). Alert includes **[📝 Force close]** button that sends `:q!` `Enter`. Cooldown: 5 min, resets when editor closes.

#### Credential prompt detection

Detects `Password:`, passphrase, or git https Username prompts blocking the session. Informational alert. Cooldown: 5 min.

#### Crash / restart detection

Detects `[run-cli] Exited with code N` from the auto-restart wrapper. Informational alert; `run-cli.sh` restarts automatically. Cooldown: 3 min.

#### Architecture

- `scripts/tmux-watchdog.ts` — replaces `tmux-permission-watcher.ts`; all detectors in one file
- `scripts/admin-daemon.ts` — starts the watchdog; adds `tmux_send_keys` command handler
- `bot/commands/tmux-actions.ts` — new `tmux:ACTION:PROJECT` callback handler
- `bot/callbacks.ts` — registers `tmux:` prefix
- `memory/db.ts` — migration v16: `tmux_target TEXT` column on `permission_requests`
- `docs/tmux-watchdog.md` — architecture and detector reference
- `tests/unit/tmux-watchdog.test.ts` — 64 unit tests for all pure detection functions

Only windows with `status = 'active'` DB sessions are polled; idle projects are skipped entirely.

#### Telegram timeout fix (v1.23.x backport)

- `channel/telegram.ts` — `FETCH_TIMEOUT_MS = 10 s` + `MAX_TOTAL_MS = 60 s` total deadline on all Telegram API calls; prevents infinite hang on network stall (root cause of 37-min session freezes)
- `channel/permissions.ts` — fast-fail auto-deny when `sendTelegramMessage` fails instead of silently polling for 10 min

---

## v1.23.0

### Admin Daemon Auto-Start

- **`helyx up` now starts admin-daemon** — `ensureAdminDaemon()` is called after tmux windows are launched; checks `pgrep` and spawns `admin-daemon.ts` in background if not running. Applies to both fresh start and "already running" branches.
- **`helyx setup` installs systemd service** — copies `scripts/helyx.service` to `/etc/systemd/system/helyx@USER.service` and enables it so `helyx up` + admin-daemon auto-start on boot. Gracefully skips with manual instructions if sudo is unavailable.
- **`/projects` ▶️ Start button now works out of the box** — previously required admin-daemon to be started manually; now guaranteed to be running after any `helyx up`.

## v1.22.0

### UX Improvements

- **Voice to disconnected topic** — early exit before Whisper transcription; user sees a clear error with `/standalone` hint instead of a silent failure
- **Better "session not active" message** — shows project path, explains auto-reconnect, links to `/standalone` and `/sessions`
- **Typing indicator refresh** — typing action re-sent every 4s during long responses; correctly targets forum topic via `message_thread_id`
- **Queue depth feedback** — "⏳ In queue (#N)..." message when a request is waiting behind another in the per-topic queue
- **`/quickstart` command** — 5-step onboarding guide: forum group → project add → Claude Code launch
- **Session crash notifications** — forum topic receives a message when a session terminates unexpectedly
- **`escapeHtml()` utility** — shared in `bot/format.ts`; all user-supplied strings in HTML messages are now properly escaped
- **N+1 SQL eliminated** in `sessions/manager.ts` — `project_path` merged into existing SELECTs in `disconnect()` and `markStale()`

## v1.21.0

### Interactive Polls

Claude can ask clarifying questions as native Telegram polls (`send_poll` MCP tool). You tap answers, press **Submit ✅**, and results flow back automatically as a user message. Supports forum topic routing, 24h expiry, and vote retraction. See [Interactive Polls guide](guides/polls.md).

### Read Receipts

👀 reaction when the bot receives your message, ⚡ when Claude Code picks it up and starts working.

### Codex Code Review

OpenAI Codex CLI integration for AI-powered code review. Authenticate headlessly via `/codex_setup` (device flow, no terminal needed). Trigger via `/codex_review` or natural language. Falls back silently to Claude's native review on quota or auth errors. See [Codex Review guide](guides/codex.md).

### `/forum_clean` command

Scans all projects with a `forum_topic_id`, validates each against the Telegram API, and nulls out IDs that correspond to deleted topics. Run `/forum_sync` afterward to recreate missing topics.

## v1.20.0

### Forum Topics — One Topic Per Project

The primary UX model is now a **Telegram Forum Supergroup** where each project has a dedicated topic:

- `/forum_setup` — run once in the General topic; bot creates one topic per registered project and stores the group ID in `bot_config`
- `/project_add` — automatically creates a forum topic for the new project when forum is configured
- **Message routing** — `sessions/router.ts` resolves `message_thread_id` → project → active session; General topic (thread ID = 1) is control-only
- **Status messages** — `StatusManager` in `channel/status.ts` sends all status updates to the project topic; project name prefix suppressed (the topic already identifies the project)
- **Permission requests** — `PermissionHandler` in `channel/permissions.ts` sends Allow/Always/Deny buttons to the correct project topic
- **`reply` and `update_status` MCP tools** — automatically include `message_thread_id` when called from a forum session
- **Forum cache** — `bot/forum-cache.ts` lazy-loads `forum_chat_id` from DB with invalidation on setup/sync
- **DB migration v13** — `forum_topic_id INTEGER` column on `projects`, `bot_config` table for runtime settings
- **34 new unit tests** — `tests/unit/forum-topics.test.ts` covers routing logic, icon color rotation, `replyInThread`, StatusManager forum target, PermissionHandler forum target, migration schema shape
- **Backward compatible** — if `/forum_setup` was never run, the bot operates in DM mode unchanged

## v1.19.0

### Lease-Based Session Ownership
Replaced `pg_advisory_lock` with a `lease_owner` + `lease_expires_at` column in the `sessions` table (migration v12). The lease is renewed every 60 seconds; if the channel process crashes, the lease auto-expires after 3 minutes and another process can take over. Eliminates orphaned locks and connection-scope issues from PostgreSQL pool reconnects.

### Session State Machine
`sessions/state-machine.ts` defines valid status transitions and enforces them atomically. Invalid transitions (e.g., `terminated → active`) are blocked with a warning log. All disconnects in `sessions/manager.ts` and `channel/session.ts` now route through `transitionSession()`.

### File Intent Prompt

Files and photos received without a caption now trigger a prompt: `📎 filename saved. What should I do with it?`. The bot waits up to 5 minutes for the user's reply, then forwards the file to Claude with that text as the caption. Files with a caption still forward immediately.

### MessageService & SummarizationService
`services/message-service.ts` and `services/summarization-service.ts` wrap short-term memory and summarizer functions with a clean typed API, including `queue()` with attachments support and `pendingCount()`.

### Centralized Telegram API Client
`channel/telegram.ts` now exposes a unified `telegramRequest()` with automatic retry on 429 (respects `retry_after`) and 5xx errors (3 retries with backoff). All tool calls and status updates route through it.

### Cleanup Jobs with Dry-Run
`cleanup/jobs.ts` exposes `runAllCleanupJobs(dryRun)` with per-job row counts. `handleCleanup` in the bot and `helyx cleanup --dry-run` in the CLI use it to preview or apply cleanup.

### Security Fail-Fast
Bot exits immediately at startup if `ALLOWED_USERS` is empty and `ALLOW_ALL_USERS=true` is not set. No silent open-access deployments.

### Anthropic CLI Usage Tracking

Claude Code (Anthropic) model usage is now visible in the dashboard Stats page and the Telegram Mini App session monitor. When a CLI session response completes, the token count captured from the tmux/output monitor is recorded in `api_request_stats` with `provider=anthropic` and model from the session's `cli_config`. The "By model" table in both UIs now shows Sonnet/Opus/Haiku usage alongside standalone providers (Google AI, OpenRouter, Ollama).

### Media Forwarding

Photos, documents, and videos forwarded to Claude via MCP channel with structured `attachments` field (`base64` for images ≤5 MB, `path` for larger files). Migration v11 adds `attachments JSONB` to `message_queue`.

## v1.18.0

### Service Layer

`services/` directory introduces typed, testable wrappers over raw SQL for all domain operations. `ProjectService.create()` atomically handles INSERT + remote session registration. `PermissionService.transition()` enforces the state machine — `pending → approved | rejected | expired` — and rejects re-transitions into terminal states.

### Structured Logging (Pino)

All `console.log/error/warn` replaced with Pino structured logging. `logger.ts` exports two loggers: `logger` (stdout) and `channelLogger` (stderr fd 2, safe for MCP stdio). Every log entry carries structured fields (`sessionId`, `chatId`, `messageCount`) — searchable with any JSON log aggregator. Set `LOG_LEVEL=debug` in `.env` for verbose output.

### Channel Adapter — 7 Modules

The `channel.ts` monolith is now `channel/` with focused modules: `session.ts`, `permissions.ts`, `tools.ts`, `status.ts`, `poller.ts`, `telegram.ts`, `index.ts`. Each module owns one concern; the entrypoint wires them together.

### Environment Validation (Zod)

`config.ts` validates all env vars with Zod at startup. Missing required variables produce a clear error and immediate exit instead of a runtime crash on first use. `ALLOWED_USERS` is now required — `ALLOW_ALL_USERS=true` must be set explicitly for open access.

### Unit Test Suite

43 pure unit tests with no DB, no network, no Telegram: `tests/unit/session-lifecycle.test.ts`, `tests/unit/permission-flow.test.ts`, `tests/unit/memory-reconciliation.test.ts`. Run with `bun test tests/unit/` — completes in ~24ms.

## v1.17.0

See [ROADMAP](docs/ROADMAP.md) for earlier version history.

## v1.14.0

### Google AI Provider in Setup Wizard

Re-added Google AI (Gemma 4) as an interactive option in `helyx setup`. The wizard now presents all four supported providers: Anthropic / Google AI / OpenRouter / Ollama. Selecting Google AI prompts for `GOOGLE_AI_API_KEY` and `GOOGLE_AI_MODEL` (default: `gemma-4-31b-it`).

### MCP Tools: react and edit_message in Channel Adapter

Added `react` (set emoji reaction) and `edit_message` (edit a bot message) to the `channel.ts` stdio MCP adapter. Both tools were already available in the HTTP MCP server — now they work in all connection modes.

## v1.13.0

### Telegram Mini App — Claude Dev Hub

A mobile-first WebApp accessible via the **Dev Hub** button in Telegram. Features:
- **Git browser** — file tree, commit log, status, diff viewer
- **Permission manager** — Allow / Deny / Always Allow from mobile
- **Session monitor** — live session status (working/idle/inactive), API stats by model (including Anthropic Claude usage from CLI sessions), token totals with cost estimate, permission history with tool breakdown, recent tool calls

See [Mini App Guide](guides/webapp.md) for full feature description and auth details. Full technical spec: [`dashboard/webapp/SPEC.md`](dashboard/webapp/SPEC.md)

## v1.12.0

### Local Session Management

- **Delete local sessions from Telegram** — `/sessions` now shows `🗑 Delete` inline buttons for local sessions that are not active; clicking deletes all session data and refreshes the list
- **Delete local sessions from dashboard** — Sessions table gains a `Delete` action column; button is visible only for `source=local` + non-active rows; uses `useMutation` with query invalidation
- **`source` field in sessions API** — `GET /api/sessions` and `GET /api/overview` now return `source` (`remote` | `local` | `standalone`); added to `Session` TypeScript interface

### Session Source Refactoring

Three distinct modes now instead of two:

| `CHANNEL_SOURCE` env | Mode | DB behavior |
|---|---|---|
| `remote` | `helyx up` / tmux | One persistent session per project; reattaches on reconnect |
| `local` | `helyx start` | New temporary session each run; work summary on exit |
| _(not set)_ | Plain `claude` | No DB registration (`sessionId = null`), no polling |

Previously, unset `CHANNEL_SOURCE` defaulted to `local`. Now it is a distinct standalone mode that skips DB entirely — preventing phantom sessions when running `claude` without the bot.

### CLI Changes

- **`helyx start`** — no longer invokes `run-cli.sh`; spawns `claude` directly with `CHANNEL_SOURCE=local` (simpler path, no auto-restart loop for local sessions)
- **`helyx restart`** — after rebuild, syncs `TELEGRAM_BOT_TOKEN` from `.env` into `~/.claude.json` MCP server config (`syncChannelToken`), so channel auth stays in sync without manual edits
- **`run()` helper** — new `stream: true` option pipes stdout/stderr directly to terminal (used in restart for real-time build output)

## v1.11.0

### Dashboard Project Management
- **Projects page** — create, start, and stop projects directly from the web dashboard (previously Telegram-only)
- **SSE notifications** — `GET /api/events` streams `session-state` events to dashboard via Server-Sent Events
- **Browser notifications** — dashboard requests Notification permission and shows push notifications on session state changes
- **Projects API** — `GET/POST /api/projects`, `POST /api/projects/:id/start|stop`, `DELETE /api/projects/:id`

### Memory TTL per Type
- **Per-type retention** — each memory type has its own TTL: `fact` 90d, `summary` 60d, `decision` 180d, `note` 30d, `project_context` 180d
- **Hourly cleanup** — expired memories deleted automatically based on `created_at`
- **Configurable** — override via `MEMORY_TTL_FACT_DAYS`, `MEMORY_TTL_SUMMARY_DAYS`, etc.
- **DB migration v9** — `archived_at` column + partial index on `memories` table

## v1.10.0

### Smart Memory Reconciliation
- **LLM deduplication** — `/remember` and work summaries no longer blindly insert; similar memories are found via vector search, then `claude-haiku` decides ADD / UPDATE / DELETE / NOOP
- **Updated replies** — `/remember` now shows `Saved (#N)` / `Updated #N` / `Already known (#N)` based on what actually happened
- **project_context deduplication** — session exit summaries update existing project context instead of accumulating duplicates
- **Graceful fallback** — Ollama or Claude API unavailable → falls back to plain insert, no data loss
- **New config** — `MEMORY_SIMILARITY_THRESHOLD` (default `0.35`) and `MEMORY_RECONCILE_TOP_K` (default `5`)

## v1.9.0

### Session Management Redesign
- **Persistent Projects** — `projects` DB table, `/project_add` saves to DB (not JSON file)
- **Remote/Local Sessions** — one remote session per project (persistent), multiple local (temporary per process)
- **Work Summary on Exit** — local session exit triggers AI summary of work done ([DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]), vectorized to long-term memory
- **Session Switch Briefing** — switching sessions shows last project context summary, injected as system context
- **Semantic Search** — `search_project_context` MCP tool + `search_context` command
- **Archival TTL** — messages and permission_requests archived on summarize, deleted after `ARCHIVE_TTL_DAYS` (default 30)
- **Status vocab** — `active | inactive | terminated` (was `active | disconnected`)
- **DB migrations v6-v8** — projects table, archived_at columns, project_id FK, unique remote-per-project

## v1.8.0

### Skills & Commands Integration
- **`/skills`** — Interactive skill browser with inline buttons (reads from `~/.claude/skills/`)
- **`/commands`** — Custom command launcher (reads from `~/.claude/commands/`)
- **`/hooks`** — View configured Hookify rules
- **Deferred input** — Tools requiring args prompt user then enqueue
- **Icon support** — 38+ emojis for quick visual identification

### Session Management Commands
- **`/add`** — Register project as Claude Code session (prompts for path, auto-switches)
- **`/model`** — Select Claude model via inline buttons (stored in `cli_config.model`)
- **Adapter pattern** — `adapters/ClaudeAdapter` (message_queue), extensible registry
- **Session router** — `sessions/router.ts` typed routing: standalone / cli / disconnected

### CLI Refactoring
- **`start [dir]`** — Register + launch project in current terminal (replaces old start = docker-only)
- **`docker-start`** — New command for `docker compose up -d` (old `start` behavior)
- **`add [dir]`** — Now registration-only (saves to config + bot DB, no launch)
- **`run [dir]`** — New command to launch registered project in terminal
- **`attach [dir]`** — New command to add window to running tmux `bots` session
- **tmux session renamed** — `claude` → `bots` (hosts both claude and opencode windows)

### Database Improvements
- **JSONB normalization** — Safe PostgreSQL storage with explicit casting
- **Read-merge-write** — Concurrent-safe provider config updates

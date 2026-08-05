# Self-Observability — PRD

Version: 1.0.0

## 1. Problem

The supervisor answers three questions every minute: are the containers up, is
the queue moving, are the sessions warm. It has never been asked a fourth — is
anything the bot does failing — and the answer, on 2026-08-05, was yes in four
separate places at once.

None of the four announced itself. Each was found by a person who went looking
for something else:

- a feature that has produced nothing since it shipped, logging one warning per
  attempt, 4136 of them;
- a voice pipeline failing its first provider on every single message;
- a container state the health analyst structurally cannot see;
- a Telegram topic deleted underneath a project, after which every answer that
  project sent went to the wrong place and reported success.

The common shape is not "an alert was missed". It is that no alert was ever
capable of firing. A failure that logs and continues is, to this system,
indistinguishable from success.

## 2. Evidence

Every claim below was read from the running system on 2026-08-05.

### D1 — fact extraction has never run

`mcp/server.ts:670` calls `extractFactsFromTranscript(transcript_path,
project_path)` from the Stop hook. `transcript_path` is a host path, e.g.
`/home/altsay/.claude/projects/<slug>/<id>.jsonl`. The bot runs in a container
where the host config is mounted at `HOST_CLAUDE_CONFIG=/host-claude-config`;
`/home/altsay` does not exist there — verified with `ls` inside `helyx-bot-1`.

`memory/summarizer.ts:436` therefore takes the `existsSync` branch, logs
`extractFactsFromTranscript: file not found` and returns 0. `logs/bot.log`
holds **4136** such lines.

The translation this needs already exists as a tested function:
`claudeConfigRoot()` in `utils/transcript-locate.ts:64`, written for the status
monitor, which reads the same files correctly from the same container.

### D2 — the error stream is unwatched

Three distinct repeating defects were live in one day's log:

| Symptom | Volume | How it was found |
|---|---|---|
| `tts: Yandex error` — 401 PermissionDenied, every voice message | one per synthesis | reading logs during an unrelated check |
| `extractFactsFromTranscript: file not found` | 4136 | reading logs during an unrelated check |
| `access denied` for the bot's own reaction updates | one per operator message | reading logs during an unrelated check |

The third is fixed; the point is that all three were found the same way. The
supervisor reads Docker, `message_queue`, `sessions`, `active_status_messages`
and `process_health`. It does not read `logs/bot.log`.

### D3 — the second copy of a fixed bug

`scripts/supervisor.ts:655` (status broadcast) lists containers with
`docker ps -a` and carries a comment explaining that `docker ps` alone hides an
exited container, so a crash loop reports green. That was flow 004's finding.

`scripts/supervisor.ts:1116` (`collectSystemSnapshot`, feeding the Gemma health
analyst, Loop 6) still runs `docker ps` without `-a`. The analyst is asked to
judge system health from a list that cannot contain a dead container.

### D4 — a send into a deleted topic

Telegram does not reject `sendMessage` with a `message_thread_id` whose topic
was deleted. Verified directly against the API on 2026-08-05: thread `1159`
(project `keryx`, deleted from a client) returned `ok: true` with **no**
`message_thread_id` in the result, while live threads `1158` and `1160` echoed
theirs back and a never-existent `999999` returned `message thread not found`.

Consequences, both observed: every reply from that project went to General with
no error, and `/forum_clean` — which exists to clear exactly this — could not
detect it, because `validateTopicExists` probed with `sendChatAction`, which
answers `ok` for `999999` too.

Fix written and tested on 2026-08-05, deployed nowhere: a real probe in
`services/forum-service.ts`, and a thread-miss report in the one function every
channel send passes through, `telegramRequest` in `channel/telegram.ts`.

## 3. Goal

A failure that the system can see, the system reports — without a person
reading a log file to find it.

Concretely: the four defects above, and the next one of their kind, surface as
a supervisor alert within one detection interval of first occurrence.

## 4. Users

| User | Need |
|---|---|
| Operator (Telegram) | To be told, once, that something started failing — not to audit logs |
| Maintainer | A named defect with the file, the count and the window, not "something is wrong" |
| Health analyst (Loop 6) | An honest container list, including what has died |

## 5. Requirements

### R1 — fact extraction resolves paths from the process's own point of view

`extractFactsFromTranscript` must translate an incoming host path through
`claudeConfigRoot()` before testing for existence, and fall back to
`resolveTranscript(projectPath)` when the translated path is also absent.

A path that cannot be resolved after both attempts stays a warning — the
warning is correct, it was only ever the *only* outcome that was wrong.

### R2 — the bot's error stream is watched

A supervisor loop reads new lines appended to `logs/bot.log` since its last
pass, counts entries at `level >= 50` (error) and `level >= 40` (warning)
grouped by `msg`, and alerts when a group crosses a threshold within a window.

The alert names the `msg`, the count, the window and the first `file:line` if
the entry carries one. Repeat alerts for the same `msg` are deduplicated by the
supervisor's existing dedup key mechanism.

### R3 — one answer to "which containers exist"

`collectSystemSnapshot` uses the same command and the same classification as
the status broadcast. The two call sites must not be able to disagree again:
the command belongs in one exported function, used by both.

### R4 — a send that misses its topic is reported

Already written, pending deployment. Restated here so the package is complete:
a send that requested a thread and came back without it (or with another) logs
at error level naming the requested topic and where the message landed, and
`validateTopicExists` returns a verdict Telegram actually supports.

### R5 — no new silent failure paths

Every new check must fail loudly in the supervisor's own log if it cannot run
(log file unreadable, `docker` missing). A monitor that quietly stops running
is the defect this package exists to remove.

## 6. Success Criteria

| # | Criterion | How it is verified |
|---|---|---|
| S1 | `extractFactsFromTranscript` runs to completion in the container | a Stop hook produces either `done` or `too few turns`, and `file not found` stops appearing |
| S2 | A defect that logs at error level ≥ N times in the window produces exactly one alert | unit test over the counter; then observed against the live Yandex 401 |
| S3 | An exited container appears in the Gemma snapshot | stop a container, read the next snapshot |
| S4 | `/forum_clean` clears a deleted topic and leaves live ones alone | unit tests exist (`tests/unit/forum-topic-validation.test.ts`); confirmed against the API once deployed |
| S5 | No monitor fails silently | each new loop logs its own failure and is asserted in tests |

## 7. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Alert flood on first enable | The operator mutes the channel, which is worse than silence | Ship with a threshold and a dedup window; enable on a known-clean log first |
| The log watcher reads a rotating file | Missed or duplicated lines | Reuse `TranscriptTail`'s discipline — inode check, offset-is-a-boundary check — rather than re-deriving it |
| Threshold tuned to today's noise | A slow leak stays under it forever | Alert on *new* `msg` values as well as on volume |
| D1's fallback resolves the wrong transcript | Facts attributed to the wrong project | `resolveTranscript` matches on the transcript's declared `cwd`, not on a computed slug |

## 8. Recommendation

Take R1, R3 and R4 first: they are small, they are in files already staged for
the next rebuild, and each closes a defect that is live right now. R2 is the
larger piece and the one that changes the class of problem — it is the only
requirement here that would have caught the other three without a person.

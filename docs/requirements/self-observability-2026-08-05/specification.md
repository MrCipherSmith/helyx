# Self-Observability — Specification

Version: 1.0.0

## 1. Identity

| Field | Value |
|---|---|
| Package | `self-observability-2026-08-05` |
| Kind | `implementation-plan` over existing modules |
| Owner module | `scripts/supervisor.ts` (host, inside `admin-daemon`) |
| Also touches | `memory/summarizer.ts`, `channel/telegram.ts`, `services/forum-service.ts` |
| Runtime | Host process, not the container — the supervisor runs beside Docker, not inside it |

## 2. Where the work lands

The supervisor is a set of `setInterval` loops started by `startSupervisor(sql,
runShell)` from `scripts/admin-daemon.ts:140`. Today:

| Loop | Interval | Subject |
|---|---|---|
| 1 | 60 s | hung sessions (heartbeat age) |
| 2 | 60 s (+15 s offset) | stuck queue |
| 3 | 5 min | voice status cleanup |
| 4 | 5 min | full status broadcast |
| 5 | 30 min | idle session auto-compact |
| 6 | 10 min | Gemma health analyst |
| 7 | 2 min (+45 s offset) | unanswered messages |
| 8 | 20 s | is the bot alive |
| — | 60 s (+30 s offset) | recovery check |
| — | 30 s | `process_health` heartbeat |

This package adds **Loop 9 — error stream** and modifies Loop 6's snapshot. The
offsets exist to spread database load; a new loop must pick one that does not
collide.

## 3. Task T1 — fact extraction resolves its own paths

**File:** `memory/summarizer.ts:430–439`.

Signature is unchanged. Before `existsSync`, the incoming path is translated:

1. If the path exists as given, use it (host process, tests).
2. Otherwise, if it starts with a `.claude` directory segment, rebuild it under
   `claudeConfigRoot()` and test again.
3. Otherwise, ask `resolveTranscript(projectPath)` — which matches on the
   transcript's own declared `cwd` and needs no slug arithmetic.
4. Only if all three fail, warn as today.

**Contract:** the function returns the number of facts saved, as now. Nothing
downstream changes.

**Tests:** a fixture directory standing in for both roots; one case per branch,
including the fourth (still not found → warning, return 0).

## 4. Task T2 — Loop 9, the error stream

**File:** `scripts/supervisor.ts`, new exported function
`checkErrorStream(sql, readLines?)`, started at 90 s with a 25 s offset.

### Input

`logs/bot.log` — one JSON object per line, pino format: `level` (30 info,
40 warn, 50 error), `time` (ms), `msg`, plus arbitrary context fields.

Reading is incremental and must survive truncation and replacement. The
discipline is already written and tested in `utils/transcript-locate.ts`
(`TranscriptTail`): hold the unterminated remainder, compare the inode, verify
the stored offset sits after a newline. Reuse it; do not re-derive it.

### Aggregation

```text
window          = 15 min (rolling, held in memory)
group key       = msg
error threshold = 10 occurrences of one msg at level >= 50 in the window
warn threshold  = 200 occurrences of one msg at level >= 40 in the window
novelty rule    = a msg at level >= 50 not seen in the previous 24 h alerts on
                  first occurrence, whatever the count
```

Thresholds are constants at the top of the loop, named and commented, not
literals at the call site.

### Alert

Routed through the existing `sendAlertWithButtons`, dedup key
`error_stream:<msg>`, so the supervisor's acknowledge window applies unchanged.

```text
⚠️ Ошибки в логе бота
<msg>
<count> раз за <window> мин · впервые <HH:MM>
<first context field, if any>
```

### Failure of the loop itself

If the log file cannot be opened, the loop logs
`[supervisor] error stream unreadable: <reason>` and continues. Two consecutive
failures raise one alert with dedup key `error_stream:unreadable` — R5.

## 5. Task T3 — one container list

**Files:** `scripts/supervisor.ts:655` and `:1116`.

Extract the command and its parsing into one exported function:

```ts
export async function listComposeContainers(
  runShell: RunShell,
): Promise<ContainerHealth[]>
```

`docker ps -a` with the compose-project label, exactly as the status broadcast
does today. Both call sites use it. `collectSystemSnapshot` renders the result
into its text block instead of shelling out itself.

**Acceptance:** grep for `docker ps` in `scripts/supervisor.ts` returns one
occurrence.

## 6. Task T4 — thread miss (written, not deployed)

**Files:** `channel/telegram.ts`, `services/forum-service.ts`.

State as of 2026-08-05:

- `reportThreadMiss(method, body, result)` called from `telegramRequest` on
  every successful response; logs at error level when a requested
  `message_thread_id` is absent from or different in the result.
- `validateTopicExists` sends a real probe and deletes it in `finally`,
  replacing the `sendChatAction` probe that answered `ok` for a thread id that
  never existed.
- Tests: `tests/unit/telegram-thread-miss.test.ts` (5),
  `tests/unit/forum-topic-validation.test.ts` (5). Full suite 1443 pass,
  `tsc --noEmit` clean.

**Remaining:** deployment only — a bot rebuild for `forum-service.ts` and a
session bounce for `channel/telegram.ts`. Recorded here so the package does not
claim work that is done, nor omit work that is pending.

## 7. Data contracts

No schema changes. No new tables. Loop 9 holds its window in memory and is
therefore reset by an `admin-daemon` restart — deliberate: an alert about
errors that stopped an hour ago is noise, and `logs/bot.log` remains the record.

## 8. Integration points

| Point | Contract |
|---|---|
| `startSupervisor` | Registers Loop 9 and clears its timer on shutdown alongside the others |
| `sendAlertWithButtons` | Unchanged; new dedup keys only |
| Acknowledge window (🔕) | Applies to the new alerts through the existing `refreshAcks` check |
| `process_health` | Loop 9 does not write to it; `updateProcessHealth` already covers supervisor liveness |
| Gemma analyst (Loop 6) | Consumes `listComposeContainers` instead of its own `docker ps` |

## 9. Acceptance criteria

| # | Criterion |
|---|---|
| A1 | `extractFactsFromTranscript` finds a transcript from inside the container; `file not found` stops appearing in `logs/bot.log` |
| A2 | T1 has one test per resolution branch, including the unresolvable one |
| A3 | Loop 9 alerts once — not per occurrence — for a `msg` crossing its threshold |
| A4 | Loop 9 alerts on the first occurrence of a previously unseen error `msg` |
| A5 | Loop 9 survives log truncation and replacement without duplicating or skipping lines, proved by test |
| A6 | Loop 9 reports its own inability to read the log |
| A7 | `docker ps` appears once in `scripts/supervisor.ts`; both consumers use the shared function |
| A8 | An exited container appears in the Gemma snapshot, proved by test with a fake `runShell` |
| A9 | T4 is deployed and `/forum_clean` clears a deleted topic against the live API |
| A10 | Whole suite green, `tsc --noEmit` clean, health gate no worse than before |

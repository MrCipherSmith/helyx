# Implementation Plan

Status: formalized

## Approach

Two pieces, split on the line the repository already splits on: the decision is
pure and lives in `utils/`, the loop that feeds it is in the supervisor.

### `utils/error-stream.ts` — what counts as worth telling

```ts
export interface LogEntry { level: number; time: number; msg: string; detail?: string }
export function parseLogEntry(line: string): LogEntry | null

export interface StreamAlert {
  msg: string; level: number; count: number; firstAt: number;
  reason: "novel" | "volume"; detail?: string;
}

export class ErrorWindow {
  observe(lines: string[], now: number): StreamAlert[]
}
```

Two rules, and each exists because the other cannot see its case:

- **Volume** — one `msg` crossing a threshold inside a rolling window. Catches
  the 4136-warnings case, where nothing is new and everything is wrong.
- **Novelty** — an error-level `msg` not seen before alerts on its first
  occurrence. Catches the slow leak that never reaches a threshold, and would
  have caught the Yandex 401 the day it started rather than weeks later.

Novelty needs a definition of "before", and the honest one is bounded: a `msg`
is novel if it has not been seen since the watcher started or in the last 24
hours, whichever is shorter. The reader starts at the end of the file, so a
restart does not replay history and call it new.

### `checkErrorStream` in `scripts/supervisor.ts` — Loop 9

Every 90 s, offset 25 s from its neighbours. Reads what has been appended since
the last pass through `TranscriptTail` — the incremental reader written for the
status monitor, which already handles the two things that go wrong here: a line
is not a line until its newline arrives, and a file that shrank or changed inode
is not the same file. Re-deriving that would be the third copy of it.

Alerts go through `sendAlertWithButtons` with dedup key `error_stream:<msg>`, so
the 5-minute dedup window and the 🔕 acknowledgement apply with no new
mechanism.

### Rejected alternatives

- **Alert on every error line.** The Yandex 401 fires per voice message; the
  operator would mute the topic inside an hour, which is worse than silence.
- **Grep the file each pass.** 3.3 MB re-read every 90 s, and no way to tell a
  line already reported from one just written.
- **A count of errors, without the message.** "12 errors in 15 minutes" tells
  the operator to go and read the log — the thing this exists to replace.
- **Reading the channel processes' stderr as well.** They have no log file; that
  is a separate problem and pretending to cover it here would be worse than
  saying it is out of scope.

## Steps

1. `utils/error-stream.ts`: `parseLogEntry`, `ErrorWindow` with both rules.
2. Tests against real pino lines taken from `logs/bot.log`.
3. `checkErrorStream` + Loop 9 in `scripts/supervisor.ts`, using `TranscriptTail`.
4. A test that drives the loop with a fake tail and a fake alert sink.
5. CHANGELOG entry.

## Risks

- **Alert flood on first enable.** Thresholds and the dedup window bound it, and
  novelty is per message rather than per occurrence. The first hour after
  deployment is worth watching regardless.
- **A threshold tuned to today's noise.** Which is why novelty exists beside it:
  a new error does not have to be loud to be reported.
- **The window is in memory and resets with the daemon.** Deliberate: an alert
  about errors that stopped an hour ago is noise, and the log remains the
  record.

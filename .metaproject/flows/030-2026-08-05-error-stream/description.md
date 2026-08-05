# Nothing watches what the bot says about itself

Status: formalized
Source: user description → package `docs/requirements/self-observability-2026-08-05` (defect D2)

## Problem

The supervisor runs ten scheduled checks. They read Docker, `message_queue`,
`sessions`, `active_status_messages` and `process_health`. Not one of them reads
`logs/bot.log`.

On 2026-08-05 three distinct repeating defects were live in a single day's log,
and all three were found the same way — by a person reading the file while
looking for something else:

| Symptom | Volume that day |
|---|---|
| `tts: Yandex error` — 401 PermissionDenied on every voice message | one per synthesis |
| `extractFactsFromTranscript: file not found` | 4136 |
| `access denied` for the bot's own reaction updates | one per operator message |

The first is still live. The second and third are fixed — by hand, after being
noticed by accident.

A failure that logs and continues is, to this system, indistinguishable from
success. That is the defect: not a missed alert, but that no alert was ever
capable of firing.

## Expected Outcome

- A repeated error in `logs/bot.log` produces one supervisor alert naming the
  message, the count and the window.
- An error message never seen before produces an alert on its first occurrence,
  whatever the count — a slow leak never reaches a volume threshold.
- The watcher survives log truncation and replacement without duplicating or
  skipping lines, and says so in the supervisor's own log when it cannot read
  the file at all.

## Out of Scope

- Shipping logs anywhere. The bot already writes structured JSONL; the gap is
  that nobody reads it, not where it is stored.
- Alert routing, escalation and acknowledgement — `sendAlertWithButtons`, the
  dedup key and the 🔕 window exist and are reused unchanged.
- Fixing the defects the watcher will find. The Yandex 401 is a live example and
  stays live: this flow builds the eye, not the cure.
- The channel subprocesses' own log stream, which goes to stderr under tmux and
  has no file to tail.

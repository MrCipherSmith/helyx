# Helyx v1.58.0 Release Notes

**Released:** 2026-09-01

A release from a full-project review pass — a shared rate budget that stopped
real replies from starving, two admin-authorization holes closed in opposite
directions, a Telegram tool that could be steered into exfiltrating local
files, a long tail of session-lifecycle and correctness fixes, and the tmux
fleet-kill bug that took today's session flock down mid-review.

## What's New

### A shared rate budget, so one busy topic can't starve another

~10 project sessions all send through the same bot token, and Telegram's rate
limit is per chat, not per topic. Each session throttling only itself never
stopped combined traffic from exceeding the real per-chat budget — real
replies sat undelivered for 15–30 minutes at a time on 2026-08-31, recovering
only when an unrelated restart happened to flush the queue.

A Postgres-backed token bucket is now shared across every session, split into
a priority lane (replies, response-guard alerts) and a background lane
(typing indicator, status cosmetics) so routine chrome can never starve a
real answer. Retuned three times against live production traffic before it
held. The last piece of the same starvation was `status.ts`'s own
continuation-reopen retry, confirmed live retrying every ~8s for 12+ hours
straight — it now backs off, caps its attempts, and single-flights.

### Two admin-authorization bugs, in opposite directions

An unset environment variable meant every admin check silently returned
`false` — confirm buttons that looked broken, not unauthorized. Fixing it
exposed the opposite bug in two more files: a fail-open gate that let any
allowed user reach restart, stack, and cross-project tmux-read actions with
no authorization check at all when notifications were configured off. Both
directions are closed, and the six independent copies of "is this the admin"
across the bot are now one shared check.

### A Telegram tool's local-path read had no trust boundary

`send_photo` read any absolute local path with no allowlist and uploaded it
to a caller-chosen chat — a session steered by attacker-controlled content
could have been made to read host-mounted credentials or another project's
transcript and exfiltrate it as a photo. Local paths are now confined to the
current project's tree; `chat_id` is now checked against chats the bot's
fleet actually manages before any of the Telegram-writing tools will address
it.

### A long tail of session and correctness fixes

Found in the same review: a `/remove` that could wipe a live session's
history, two raw `DELETE`s that threw on ordinary teardown instead of using
the FK-safe cascade path, a poller race that could deliver one message to
Claude twice, a silent exit-code loss on shutdown, a voice-dedup check keyed
on the wrong columns, a resume lookup that let the wrong project's memory win
on recency, a stale-session watchdog that could poll the wrong tmux window
after a crash-restart, an output tail that re-read whole files on every poll,
and seven smaller ones — a skill-file comparison, a redaction cursor, a
mixed-content check, a TTS fallback, two cost tables, and an interpolation
bug. Full list in `CHANGELOG.md`.

### An idle-session watchdog

Sessions with nothing queued, no turn in progress, and no pane activity for
2+ hours now get a Telegram alert with a Stop button, instead of running
unnoticed. It never stops anything on its own — a human still confirms.

### The tmux fleet-kill bug

`proj_start`'s fallback for a missing session started the whole fleet in
split-panes mode. The startup check counts a window per project, so that
false-flagged as a failure, which is what got the same command run a second
time — and its per-project window-kill then killed the one window carrying
every project, taking the tmux server down with it. This happened in
production on 2026-09-01 during the review this release documents; both
start paths are windows-only now.

## Upgrade

Two Postgres migrations landed in this range (v52: the shared rate budget;
v53: its priority/background split) — both already applied to the running
database as of this release. No new environment variables.

**This release touches all three halves.** The bot container needs a
rebuild for the security and rate-budget fixes in `channel/telegram.ts`,
`mcp/tools.ts`, and `bot/commands/*.ts`. CLI sessions need a bounce — the
channel subprocess changes (rate budget, path guards, admin checks) do not
reach a session already running on old code. The admin daemon needs its own
restart for the tmux fleet-kill fix and the per-project memory ceiling —
already done once during this review; the fix is live.

## Note on CI

`Build` is green on the release commit (`362edab`).

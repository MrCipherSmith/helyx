# PRD: Session Stability Reform & tmux Audit Daemon

**Date:** 2026-06-26  
**Status:** Draft v3  
**Scope:** Two independent deliverables packaged in one document

---

## Background

The Helyx system runs multiple Claude Code sessions in tmux windows, each managed by a
stack of daemons (admin-daemon → supervisor + tmux-watchdog + run-cli.sh). The user
frequently has several active sessions doing real work: one running code, one waiting on
a long process, one idle. Currently, a combination of overlapping monitoring loops, missing
idempotency guards, and a tight auto-restart wrapper causes these sessions to be killed and
restarted without user intent. Because there is no audit trail, the root cause is
impossible to diagnose post-mortem.

---

## Part 1 — Session Restart Control Reform

### Problem Statement

Three independent mechanisms can trigger a session restart without user confirmation:

1. **`checkHungSessions`** (supervisor.ts, every 60 s): fires when
   `active_status_messages.updated_at` has not been updated for more than `SESSION_STALE_MS`
   (default 5 min). Sends a Telegram alert with a "Restart" button. Dedup key:
   `hung_session:<project>`.

2. **`checkStuckQueue`** (supervisor.ts, every 60 s, offset 15 s): fires when a message in
   `message_queue` has `delivered = false` for more than 5 minutes. Sends a separate Telegram
   alert with a "Restart" button. Dedup key: `stuck_queue:<project>`. Because the dedup keys
   differ, both loops can have live alerts for the same session simultaneously.

3. **`run-cli.sh`** auto-restart loop: on any non-zero exit from Claude Code, waits 5 s and
   respawns. No restart limit. An eviction or lease-loss causes an immediate tight loop.

Additional compounding factors:

- **No idempotency in supervisor restart callbacks.** `handleSupervisorCallback` in
  `supervisor-actions.ts` inserts `proj_start` into `admin_commands` unconditionally. If the
  user presses "Restart" on both alert types for the same session, two `proj_start` commands
  queue. The second kills the window created by the first.

- **`proj_start` kills all windows unconditionally.** Before creating a new window,
  admin-daemon.ts loops `while tmux kill-window ...` until all windows for the project are
  gone. This means any second `proj_start` targeting the same session destroys the just-started session.

- **Lease fight after rapid restart.** After a `proj_start`, the new channel.ts process
  force-steals the DB lease after 5 failed attempts (~5 s). The old process detects the
  stolen lease on its next heartbeat (up to 60 s later) and exits, triggering run-cli.sh to
  restart it. For a brief window both pollers are live and can double-deliver messages.

- **`checkUnansweredMessages`** (every 2 min): re-injects messages that received no assistant
  reply within 5–30 min. During a restart window multiple copies accumulate in
  `message_queue`, creating a burst on recovery.

- **False positive hung detection.** `checkHungSessions` triggers on the ASM
  (`active_status_messages`) heartbeat, not on actual Claude activity. If the Telegram status
  message was deleted or the StatusManager heartbeat failed for any reason (network blip,
  rate limit), the supervisor considers the session hung even though Claude is actively
  computing.

### Goals

- No daemon or script automatically restarts a session. Restarts are always a deliberate
  user action via Telegram buttons.
- Alerts provide enough context for the user to make an informed decision (what is the
  session doing? when did it last respond? what does the pane look like?).
- All restart entry points are idempotent — double-pressing a button has no effect.
- run-cli.sh handles real crashes (unexpected exits) but escalates to a human after repeated
  failures instead of looping indefinitely.
- Alert volume is reduced by coordinating the two supervisor loops so one failing session
  generates one alert thread, not two.

### Non-Goals

- Removing the ability to restart sessions manually via Telegram.
- Altering how admin-daemon.ts executes the `proj_start` command itself.
- Adding new Postgres tables. Adding columns to existing tables is allowed.

### Requirements

#### REQ-1.1 — Remove automatic restart from `checkHungSessions`

`checkHungSessions` (supervisor.ts) must NOT send a button that triggers `proj_start`.

The SQL query for `checkHungSessions` must SELECT `p.id AS project_id` in addition to
existing columns, so `project_id` is available when constructing the button callback data.

Instead the alert must include:
- Session name and project path.
- Elapsed time since last ASM heartbeat, formatted as "X минут назад".
- Last 5 lines of the session's tmux pane (captured via `tmux capture-pane -p -t "bots:WINDOW"`),
  sanitized to remove ANSI escapes.
- Whether a Claude spinner (`·`, `✶`, `✻`) is detected in the pane (if yes, prepend
  "⚙️ Claude сейчас работает — возможно, не завис").

Buttons (in order, Telegram inline keyboard):
1. `callback_data: "sup:pane:PROJECT_ID"` — label "📋 Показать лог" — sends the full last 20
   pane lines as a follow-up message in the same chat.
2. `callback_data: "sup:restart_session:PROJECT_ID"` — label "🔄 Перезапустить" (or
   "⚠️ Перезапустить (Claude работает!)" if spinner detected) — enqueues restart via
   `enqueueRestart()` (see REQ-1.4).
3. `callback_data: "sup:ack:session_problem:<project_name>:<project_id>"` — label "🔇 Заглушить на 1 ч" —
   silences alerts for this session for 60 minutes using the existing `ackedUntil` mechanism.
   The ack handler must extract `parts.slice(2, 4).join(":")` as the ack key
   (i.e., `"session_problem:<project_name>"`), matching the dedup key used by `shouldAlert`.
   The fifth segment (`project_id`) is ignored in the ack path. Update `durationMin` in the
   ack handler from 30 to 60.

After calling `sendAlertWithButtons`, store the returned `message_id` into `activeAlerts`
(see REQ-1.6) under the key `"session_problem:<project_name>"`.

The `"sup:pane:PROJECT_ID"` callback must be added to `handleSupervisorCallback` in
`supervisor-actions.ts`: capture the pane and send the lines as a reply.

#### REQ-1.2 — Remove automatic restart from `checkStuckQueue`

`checkStuckQueue` (supervisor.ts) must NOT send a button that triggers `proj_start`.

Instead the alert must include:
- Session name.
- Number of stuck messages, elapsed wait time since the oldest.
- Preview of the first stuck message (first 120 chars, truncated with "…").
- Whether the pane shows an active spinner (same logic as REQ-1.1).

Buttons (in order):
1. `callback_data: "sup:force_deliver:PROJECT_ID"` — label "📬 Принудительно доставить" —
   calls `forwardStuckMessages(sql, projectId)` for this session only, without restarting it.
   This callback branch must be added to `handleSupervisorCallback`.
2. `callback_data: "sup:restart_session:PROJECT_ID"` — label "🔄 Перезапустить сессию" —
   enqueues via `enqueueRestart()` (shared with REQ-1.1, same handler).
3. `callback_data: "sup:ack:session_problem:<project_name>:<project_id>"` — label "🔇 Заглушить на 1 ч".

After calling `sendAlertWithButtons`, store the returned `message_id` into `activeAlerts`
(see REQ-1.6) under the key `"session_problem:<project_name>"`.

**`forwardStuckMessages` extension:** Add an optional `projectId?: number` parameter.
When provided, add `AND s.project_id = ${projectId}` to both the eligibility and candidate
queries in the function. Export `forwardStuckMessages` from `supervisor.ts` so it can be
called from `supervisor-actions.ts`.

#### REQ-1.3 — Merge alert dedup namespace for hung + stuck

When both `checkHungSessions` and `checkStuckQueue` detect a problem with the **same
session at the same time**, they must share a single dedup key so only one alert thread is
created.

**Dedup key:** `session_problem:<project_name>`. Both loops use this key, replacing their
current separate keys (`hung_session:<project>` and `stuck_queue:<project>`).

**Dedup storage:** Use the existing in-memory `alertedAt` Map in `supervisor.ts` (declared
at line ~49). The same `DEDUP_WINDOW_MS` (5 minutes) applies.

**Firing rule:** Whichever loop fires first (within the same 5-minute window) sends the
alert. The second loop, finding `alertedAt` already set for `session_problem:<project>`,
does NOT send a new message. Instead, it edits the existing alert message to append or
update a line indicating both conditions are active (e.g., "⚠️ Также: очередь застряла —
3 сообщения, 7 минут"). Editing requires the alert `message_id` to be stored (see REQ-1.6).

**Merged alert format** (when both conditions are detected before any message is sent):
The merged alert is constructed by whichever loop fires first and includes all sections
from both REQ-1.1 and REQ-1.2 combined into one message. Button set (maximum 3 per row,
Telegram limit):
- Row 1: "📋 Показать лог" · "📬 Принудительно доставить"
- Row 2: "🔄 Перезапустить сессию" · "🔇 Заглушить на 1 ч"

When only one condition exists at alert time, use the single-condition format from
REQ-1.1 or REQ-1.2 as applicable. The alert may be edited later to reflect the second
condition if it arises within the same dedup window.

#### REQ-1.4 — Unified `enqueueRestart(sql, projectId, reason, requestedBy)` function

Create a new exported async function in `services/project-service.ts`:

```typescript
export async function enqueueRestart(
  sql: postgres.Sql,
  projectId: number,
  reason: string,
  requestedBy: string   // "supervisor:hung" | "supervisor:stuck" | "user:button" | "run-cli" | ...
): Promise<"queued" | "skipped_already_pending">
```

The `sql` parameter must be passed by the caller so the function uses the caller's
existing connection pool, matching the dependency-injection pattern of the rest of the codebase.

Implementation:
1. **Idempotency check:** Query `admin_commands WHERE command = 'proj_start' AND (payload->>'project_id')::int = ${projectId} AND status IN ('pending', 'processing') LIMIT 1`. If found, return `"skipped_already_pending"`.
2. **Project lookup:** Query `SELECT path, name, tmux_session_name FROM projects WHERE id = ${projectId}`. If not found, throw an error. This mirrors the pattern in `ProjectService.action()`.
3. **Insert:** Insert into `admin_commands` with payload `{project_id: projectId, path, name, tmux_session_name, reason, requestedBy}` — `reason` and `requestedBy` are appended to the standard fields already expected by `admin-daemon.ts`. Return `"queued"`.

Additionally: **remove `triggerProjStart`** from `supervisor.ts` — it becomes dead code after this change.
After implementing, confirm no other caller uses `triggerProjStart`.

All callers — `supervisor-actions.ts`, `project-service.ts` public methods, any future
caller — must use this function exclusively. No direct INSERT into `admin_commands` for
restarts anywhere else in the codebase.

When the Telegram callback handler receives `"skipped_already_pending"`, it must answer the
Telegram callback query with "⏳ Перезапуск уже в очереди — ожидайте" and leave the message
unchanged.

`supervisor-actions.ts` passes its injected `sql` instance; `project-service.ts` public
methods pass their own `sql` singleton — the function is agnostic to which pool is used.

#### REQ-1.5 — `run-cli.sh` restart limit with human escalation

Add two env-configurable shell variables:
- `MAX_RESTARTS_IN_WINDOW` (default `3`)
- `RESTART_WINDOW_SECONDS` (default `300`)

State file path: `/tmp/helyx-restart-${PROJECT_NAME}.state` where `PROJECT_NAME` is derived
from the `$PROJECT_DIR` variable already available in run-cli.sh (use `basename "$PROJECT_DIR"`).

State file format (two lines): first line is the window start timestamp (Unix seconds);
second line is the restart count within that window.

Logic on each restart attempt:
1. Read the state file. If missing or window has expired (`now - window_start > RESTART_WINDOW_SECONDS`),
   reset: write current timestamp and count `1`, proceed with restart.
2. If within the window and count < MAX_RESTARTS_IN_WINDOW: increment count, write state, proceed.
3. If within the window and count >= MAX_RESTARTS_IN_WINDOW: escalate (see below), do NOT restart.

On a clean exit (exit code 0): delete the state file.

**Escalation procedure** (step 3):
1. Do NOT restart.
2. Ensure the directory exists: `mkdir -p "${PROJECT_DIR}/logs/restart-failures"`.
   Write a marker file: `${PROJECT_DIR}/logs/restart-failures/${PROJECT_NAME}-$(date +%s).failed`
   containing the last 50 lines of pane output captured via:
   `tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null | tail -50`
   (`$TMUX_PANE` is set by tmux automatically when running inside a tmux window).
   If `$TMUX_PANE` is unset (non-tmux mode), fall back to `tail -50 "$LOG_FILE"` instead.
3. Send a Telegram alert via `curl` using `$TELEGRAM_BOT_TOKEN`, `$SUPERVISOR_CHAT_ID`,
   and `$SUPERVISOR_TOPIC_ID` (all present in run-cli.sh's environment after `load_env`).
   Include `message_thread_id` = `$SUPERVISOR_TOPIC_ID` in the JSON body when the variable
   is non-empty, so the alert appears in the dedicated supervisor thread alongside all other
   supervisor alerts. Alert text:
   ```
   🚨 [PROJECT_NAME]: Claude Code перезапустился MAX раз за WINDOW сек — остановлен.
   Требуется ручной запуск.
   ```
   with one inline keyboard button:
   - label: "🔄 Запустить вручную"
   - `callback_data: "sup:start_by_pid:PROJECT_ID"` where `PROJECT_ID` is the numeric DB
     project ID (not the path). Use `PROJECT_ID` instead of a URL-encoded path to avoid
     exceeding Telegram's 64-byte `callback_data` limit.
     Before the curl call, look up the project ID from the DB using
     `psql "$DATABASE_URL" -t -c "SELECT id FROM projects WHERE path='${PROJECT_DIR}'"`.
     If the lookup fails or returns empty, fall back to logging the escalation to stderr only.
4. Exit the while loop with `exit 0` so the tmux window remains visible with the error output.

**New callback handler** for `sup:start_by_pid:<project_id>` in `supervisor-actions.ts`:
1. Parse the numeric project_id from the callback data.
2. Call `enqueueRestart(sql, projectId, "run-cli:max_restarts", "run-cli")`.
3. Reply to the callback query with "✅ Запуск поставлен в очередь" or
   "⏳ Перезапуск уже в очереди" depending on the result.

If `TELEGRAM_BOT_TOKEN` or `SUPERVISOR_CHAT_ID` are unset at escalation time, write the
escalation message to stderr only (do not fail silently — the marker file is still written).

#### REQ-1.5b — Fix `sendStatusBroadcast` stuck-message text

In `supervisor.ts`, the `sendStatusBroadcast` function currently prints:
```
⚠️ Зависших сообщений: ${stuckTotal}. Использую proj_start для восстановления...
```
After Part 1 is implemented, the supervisor never auto-restarts. Replace this line with:
```
⚠️ Зависших сообщений: ${stuckTotal}. Нажмите кнопку в алерте для перезапуска.
```

#### REQ-1.6 — Alert auto-resolution and message_id persistence

**Recovery detection:**
Extend the existing `checkHungSessions` and `checkStuckQueue` loops (or add a single shared
recovery check running at the same 60 s interval). On each tick, for each project that has
an active alert in `alertedAt` (i.e., the dedup key `session_problem:<project>` is set):
1. Re-query the hung condition (is ASM heartbeat now fresh?) and the stuck condition
   (are there still undelivered messages older than 5 min?).
2. A project is considered recovered when both checks return clean on **two consecutive
   polling ticks** (60 s apart, i.e. one full polling interval), to avoid false recovery
   on a transient heartbeat.

**Two-tick recovery tracking:** Declare a new `Map<string, number>` named `recoveryCleanSince`
in `supervisor.ts` (alongside `alertedAt`). On each tick:
- If both conditions are now clean:
  - If `recoveryCleanSince.has(key)` and `Date.now() - recoveryCleanSince.get(key)! >= 60_000`:
    trigger auto-resolution (see below); then `alertedAt.delete(key)`, `activeAlerts.delete(key)`,
    `recoveryCleanSince.delete(key)`.
  - Else if `!recoveryCleanSince.has(key)`: set `recoveryCleanSince.set(key, Date.now())`.
- If either condition is still active: `recoveryCleanSince.delete(key)` (reset the counter).

**Auto-resolution:**
Edit the existing Telegram alert message to:
```
✅ Сессия восстановилась — ждали X мин — HH:MM:SS UTC
```
Remove all inline keyboard buttons from the edited message. The existing `editTelegramMsg`
helper in `supervisor.ts` does NOT pass `reply_markup`, which means Telegram preserves the
existing buttons. For this call, use `tgPost` directly and include
`reply_markup: { inline_keyboard: [] }` in the request body to explicitly clear the keyboard.
Clear the `alertedAt` entry so a new alert can fire if the problem recurs.

**message_id persistence:**
Store the `message_id` of each sent alert in a new in-memory `Map<string, {messageId: number, chatId: number, sentAt: Date}>` named `activeAlerts` in `supervisor.ts`. Key: the dedup key (`session_problem:<project>`).
This map is process-local; if admin-daemon restarts, the map is cleared and recovery edits
will not fire for alerts sent before the restart. This is acceptable — in that case the old
alert message stays with its buttons (the user can still press them) but will not be
auto-resolved. No persistent storage is required for this feature.

**`<elapsed>` definition:** Elapsed time = `now - activeAlerts.get(key).sentAt` (time since
the alert was first sent, not since the problem was first detected).

---

## Part 2 — tmux Audit Daemon

### Problem Statement

When a session dies there is currently no record of: when exactly it died, what was in the
pane at that moment, which daemon triggered the kill, or what the exit code was. Post-mortem
analysis relies on memory and guesswork.

### Goals

- Persistent, structured log of every tmux session and window lifecycle event.
- Capture the last N lines of a pane before the window is destroyed.
- Periodic full-state snapshots so the last known good state is always recoverable.
- Simple CLI for querying events from a time range.
- Zero performance impact on the monitored sessions.

### Non-Goals

- Real-time streaming to external services or dashboards.
- Replacing the existing tmux-watchdog (they coexist).
- Storing full pane scrollback (only the tail).

### Requirements

#### REQ-2.1 — New daemon: `scripts/tmux-session-logger.ts`

A standalone Bun process that runs alongside the existing daemons. It is started by
`admin-daemon.ts` via a new `startTmuxSessionLogger(sql, runShell)` call, symmetric with
`startSupervisor` and `startTmuxWatchdog`.

The daemon never restarts sessions. Its only output is log files.

#### REQ-2.2 — Event capture via polling diff

Every 10 seconds, the daemon runs:
- `tmux list-sessions -F '#{session_id} #{session_name} #{session_created} #{session_windows}'`
- `tmux list-windows -a -F '#{session_name} #{window_id} #{window_name} #{window_active} #{pane_pid} #{pane_dead} #{pane_dead_status}'`

It diffs the result against the previous snapshot. On changes:

| Detected change | Event logged |
|---|---|
| New session appeared | `session_created` |
| Session disappeared | `session_destroyed` |
| New window appeared | `window_created` |
| Window disappeared | `window_destroyed` |
| `pane_dead` flipped to `1` | `pane_died` with `exit_code = pane_dead_status` |

For `window_destroyed` and `pane_died` events, before logging the daemon captures
`tmux capture-pane -p -t "<session>:<window>" -S -30` (last 30 lines) and includes it in the
log entry as `pane_tail`. If capture fails (window already gone), `pane_tail` is `null`.

If tmux is not running or returns no output, the daemon logs a single `tmux_unavailable`
event and retries after the normal 10 s interval. It does NOT crash.

#### REQ-2.3 — admin_commands integration

The logger must capture `proj_start`, `proj_stop`, `tmux_start`, `tmux_stop`, and `bounce`
commands as they are inserted into the `admin_commands` table by any caller
(project-service.ts, supervisor-actions.ts, remote-control.ts, etc.).

**Implementation — polling with checkpoint ID:**
The logger polls `admin_commands` every 10 seconds for rows with
`id > last_seen_id AND command IN ('proj_start','proj_stop','tmux_start','tmux_stop','bounce')`.
`last_seen_id` is initialized to the maximum `id` present at daemon startup (so only new
commands are logged). On each poll, any new rows are logged as `command_enqueued` events and
`last_seen_id` is updated.

Note: the LISTEN/NOTIFY approach is NOT used because no `admin_commands_changes` channel
exists and adding one would require a DB trigger (out of scope). Polling every 10 s is
sufficient given admin commands are low-frequency.

#### REQ-2.4 — Log format

Log files are stored in `logs/tmux-sessions/YYYY-MM-DD.jsonl` (created automatically,
including parent directories). Each line is a JSON object:

```json
{
  "ts": "2026-06-26T03:40:00.000Z",
  "event": "pane_died",
  "session": "bots",
  "window": "helyx",
  "window_id": "@12",
  "exit_code": 1,
  "pane_tail": ["line 1", "line 2", "..."],
  "trigger": "run-cli.sh",
  "metadata": {}
}
```

All fields:

| Field | Type | Present when |
|---|---|---|
| `ts` | ISO-8601 UTC string | always |
| `event` | string (enum) | always |
| `session` | string | when tmux context available |
| `window` | string | when window context available |
| `window_id` | string | when window context available |
| `exit_code` | integer | `pane_died`, `window_destroyed` |
| `pane_tail` | string[] or null | `window_destroyed`, `pane_died` |
| `trigger` | string | optional — omit if unknown |
| `metadata` | object | optional — omit if empty |

Valid `event` values: `session_created`, `session_destroyed`, `window_created`,
`window_destroyed`, `pane_died`, `command_enqueued`, `snapshot`, `daemon_started`,
`tmux_unavailable`.

For `command_enqueued`: `metadata` must contain `{command, command_row_id, project_id?}`.
`project_id` is optional — it is present for `proj_start` and `proj_stop` (extracted from
`(payload->>'project_id')::int`), but absent (`null` / omitted) for `tmux_start`, `tmux_stop`,
and `bounce` which are session-wide operations with no project scope.

#### REQ-2.5 — Periodic snapshots

Every 5 minutes the daemon writes a `snapshot` event containing:
- Full `tmux list-sessions` output parsed into an array of objects.
- Full `tmux list-windows -a` output parsed into an array of objects.
- Count of `admin_commands` rows with `status = 'pending'` (queried from DB).
- Count of `message_queue` rows with `delivered = false` (queried from DB).

All four values go into the `metadata` field of the `snapshot` event row.

#### REQ-2.6 — Daily log rotation

The daemon tracks the current UTC date at each polling tick. When the date changes, it
closes the current log file handle and opens a new one with the new date. Old log files are
not deleted automatically.

#### REQ-2.7 — Query CLI

Running the daemon script with `--query` as the first argument enters query mode instead of
daemon mode. The daemon process exits after printing results.

**Flags:**

| Flag | Type | Description |
|---|---|---|
| `--last <duration>` | string | Events from the last N time units. Accepted suffixes: `m` (minutes), `h` (hours), `d` (days). Examples: `30m`, `2h`, `1d`. |
| `--since <iso>` | string | Events at or after this ISO-8601 timestamp. |
| `--event <type>` | string | Filter to one event type. Can be repeated: `--event pane_died --event window_destroyed`. |
| `--json` | boolean flag | Output raw JSON Lines instead of a human-readable table. |
| `--include-snapshots` | boolean flag | Include `snapshot` events in output (excluded by default). |

Mutual exclusion: `--last` and `--since` cannot be used together; if both are provided, exit
with code 1 and print "Error: --last and --since are mutually exclusive".

Default output (table): columns are `Timestamp`, `Event`, `Session`, `Window`, `Details`
(Details = `exit_code` for pane_died, `command` for command_enqueued, truncated `pane_tail[0]`
otherwise).

The query reads log files only from `logs/tmux-sessions/`. If the directory does not exist,
exit with code 0 and print "No log files found."

#### REQ-2.8 — Integration with supervisor alerts

When `checkHungSessions` or `checkStuckQueue` sends an alert (REQ-1.1 / REQ-1.2), the
alert message body must include one additional line at the bottom:

```
📁 Лог сессий: /home/altsay/bots/helyx/logs/tmux-sessions/YYYY-MM-DD.jsonl
```

where `YYYY-MM-DD` is the current UTC date. The path is constructed at runtime using
`path.join(BOT_DIR, "logs/tmux-sessions", dateString + ".jsonl")` where `BOT_DIR` is
resolved from `import.meta.dir`. This produces an absolute path — do not use `~`.
This is a static text reference only; no button or query execution is required at alert time.

---

## Delivery Sequence

The two parts are independent and can be implemented in parallel.

**Part 1** files: `scripts/supervisor.ts`, `bot/commands/supervisor-actions.ts`,
`services/project-service.ts`, `scripts/run-cli.sh`.  
Deployment: channel restart only (no Docker rebuild).

**Part 2** files: `scripts/tmux-session-logger.ts` (new), `scripts/admin-daemon.ts`.  
Deployment: admin-daemon restart only.

---

## Open Questions

1. Should `enqueueRestart()` also add an audit row to a `restart_log` table, or is the
   `admin_commands` row with `{reason, requestedBy}` payload fields sufficient?
   **Disposition:** Defer. The `admin_commands` payload fields plus `supervisor_incidents`
   logging are sufficient for the MVP. A dedicated table can be added later.

2. For REQ-1.3 (merged alert dedup): should the merged alert appear in the Supervisor
   channel, the General channel, or configurable per-project?
   **Resolved:** Alerts continue to use `SUPERVISOR_CHAT_ID` / `SUPERVISOR_TOPIC_ID` as before.
   No change to the alert routing behavior.

3. Should the tmux-session-logger write summary rows to the Postgres DB (for querying via
   SQL) in addition to the JSONL files, or JSONL-only for now?
   **Disposition:** Defer. JSONL-only for the MVP. The query CLI in REQ-2.7 covers the
   primary use case; SQL querying is a separate feature with non-trivial schema implications.

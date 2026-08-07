# Restart problem: sessions not starting after full rebuild/bounce

**Date:** 2026-08-05 (incident) — fixed 2026-08-06 in `968fbf5`  
**Status:** root cause fixed in code — `decideTmuxScope()` picks the tmux scope by whether a server is reachable instead of trusting the unit's own state, and a start is no longer allowed to report success without tmux confirming it. See "Fixed" below for what shipped and where.  
**Scope:** host-side tmux sessions (not Docker)

---

## Summary

After a full rebuild and restart of helyx, Docker containers came up healthy, but **no Claude sessions could be started from Telegram**. The bot half was fine; the sessions half was stuck.

Root cause: a **stale systemd user scope** `helyx-tmux.scope` blocked creation of the `bots` tmux session. Bounce / `proj_start` / `helyx up` reported success (green checkmarks) while the session never existed.

---

## Observed symptoms

| Half | Status |
|------|--------|
| `helyx-bot-1` | Up, healthy |
| `helyx-postgres-1` | Up, healthy |
| Webhook / bot | Running |
| `helyx-admin.service` | Active |
| tmux session `bots` | **Missing** |
| Project windows | **0 of 10** |
| DB sessions | All `disconnected` / `inactive` |
| Telegram start project | Admin commands marked `done`, sessions still dead |

Telegram text routing logged `mode: "disconnected"`.

Post-restart report (from bounce log) stated:

- windows in tmux: **0 of 10**
- active in DB: **0**

---

## Root cause

### 1. Stale `helyx-tmux.scope`

From ~12:35 the user unit stayed **active**:

```text
helyx-tmux.scope
  Active: active (running)
  CGroup process: /usr/bin/tmux new-session -d -s bots -n goodai-base ...
```

That process was the **tmux server** for the user. The `bots` session had already been killed (e.g. by bounce), but the server process remained because **other tmux sessions** (bench-A1-keryx-*) still lived on the same server. The scope unit therefore never went away.

### 2. Bounce / up cannot recreate `bots`

First window start goes through `tmuxServerScope()` in `cli.ts`:

```ts
// Clear a lingering unit from a previous server so --unit does not collide.
await run(["systemctl", "--user", "reset-failed", "helyx-tmux.scope"], { silent: true });
return ["systemd-run", "--user", "--scope", "--unit=helyx-tmux", "--collect", "--quiet"];
```

Then:

```text
systemd-run --user --scope --unit=helyx-tmux tmux new-session -d -s bots ...
```

Failure:

```text
Error: Failed to start transient scope unit: Unit helyx-tmux.scope was already loaded or has a fragment file.
Error: can't find session: bots
```

`reset-failed` only clears a **failed** unit. It does **not** stop an **active** lingering scope. Collision on `--unit=helyx-tmux` is permanent until something stops that unit or the process dies.

Evidence from `/tmp/helyx-bounce.log` (~22:42):

```text
Error: Failed to start transient scope unit: Unit helyx-tmux.scope was already loaded or has a fragment file.
Error: can't find session: bots
✓ goodai-base — ...
Error: can't find window: bots
...
```

### 3. False success masking the failure

`tmuxStart()` / `startWindow()` print green `✓` **after** calling `run(...)` without treating a failed `new-session` as a hard error for the whole start path. Result:

- bounce log shows both errors and green checkmarks
- `admin_commands` rows for `proj_start` get `status = done` with truncated “Starting tmux session bots … ✓ …” output
- From Telegram it looks like start worked; nothing is actually running

### 4. Why `proj_start` could not recover

In `scripts/admin-daemon.ts`, `proj_start`:

- if `tmux has-session -t bots` → add window
- else → `helyx up -s`

When `bots` is missing, every start falls into the same broken `up` path that uses `systemd-run` + stale scope.

---

## Architecture reminder (two halves)

| Half | What | How it restarts |
|------|------|-----------------|
| Containers | `helyx-bot-1`, `helyx-postgres-1` | `docker compose up -d [--build] bot` |
| Sessions | tmux windows + `channel.ts` MCP | `bun cli.ts bounce` / `helyx up` / `proj_start` |

Rebuilding the bot **does not** restart sessions. Channel code ships only after sessions bounce. After full restart both halves must come up; here only Docker did.

---

## Recovery performed (2026-08-05)

Operational fix without killing bench tmux sessions:

1. Create `bots` **without** systemd-run (server already exists):

   ```bash
   tmux new-session -d -s bots -n _bootstrap -c /home/altsay
   ```

2. Start missing project windows:

   ```bash
   cd /home/altsay/bots/helyx && bun cli.ts up
   ```

3. Drop bootstrap window:

   ```bash
   tmux kill-window -t bots:_bootstrap
   ```

Result: all primary remote sessions became `active` (helyx, keryx, goodai, goodai-base, vantage-*, carlson-bot, altsay, kesha-voice-kit, deprecated). Claude + channel processes running.

**Note:** Stopping `helyx-tmux.scope` would also kill the shared tmux server and thus **all** user sessions including bench. Prefer creating `bots` on the existing server when possible.

---

## Fixed: code changes (shipped in `968fbf5`, 2026-08-06)

Everything below shipped in the same commit that added this doc — the P0 items from the original proposal, in full; P1/P2 partially, noted where they diverge.

### P0 — `tmuxServerScope()` now picks the scope by server reachability, not unit state

`decideTmuxScope()` (`sessions/tmux-server.ts:60`) replaces the old logic. It is a pure function — `{ platform, hasSystemdRun, hasTmuxServer }` in, `{ prefix, clearUnit, reason }` out — unit-tested without staging tmux or systemd:

- No systemd-run on PATH, or not Linux → no scope prefix.
- A tmux server is already reachable (`tmux list-sessions` succeeds) → no scope prefix; join the existing server with a plain `tmux new-session`. This is the branch that was missing: the old code only checked the unit's own state (failed vs not), never whether a server was actually running underneath it, so `reset-failed` — which only clears a *failed* unit — could not help against a unit that was legitimately `active`.
- No server reachable → stop and reset-failed the old unit, then `systemd-run --unit=helyx-tmux` as before, to keep the *first* server out of `helyx-admin.service`'s cgroup.

`cli.ts` calls this via `tmuxServerScope()` (around `cli.ts:1380`), which now stops the unit before resetting it rather than only resetting.

### P0 — No more false green ✓

`startWindow()` (`cli.ts:1396`) returns the failure reason instead of discarding exit codes — a failed `new-session`, `new-window`, or `send-keys` is no longer silently swallowed. `verifyStart()` / `verifyTmuxStart()` (`sessions/tmux-server.ts:113`, `cli.ts:1435`) then judge the run by asking tmux what actually exists (`has-session`, `list-windows`) rather than trusting the steps' own exit codes — the incident's signature was every individual step reporting success while the session didn't exist at all. `reportTmuxStart()` (`cli.ts:1452`) prints the verdict, sets a non-zero process exit on failure, and points at this doc as the runbook (`cli.ts:1459`).

The admin daemon publishes the same ground truth — session existence, window count, scope state — to `process_health` under `tmux:bots`, and `/system` (`bot/commands/system.ts`) renders it via `renderTmuxHealthLine()`, distinguishing "no session", "session but 0 windows", and "N windows running" rather than collapsing all three into one status dot.

### P0 — `/system` names the two halves instead of conflating them

The panel used to have one "Bounce (full restart)" button. It now has 🔄 Bounce (sessions only — tmux + `channel.ts`), 🐳 Restart bot (container only), plus 🚀 Поднять всё (start whatever is down, touch nothing running) and ♻️ Полный рестарт (rebuild the bot container, then bounce sessions — the only button that reaches both halves), and typed `/restart_docker` / `/restart_host` equivalents reachable without the panel rendering correctly first. `/now` (`bot/commands/now.ts`) shipped alongside these — it reads the session's own transcript directly instead of queueing a question, so the operator has a way to check a session that the queue path can't reach if it's wedged.

### P1 — `proj_start` when `bots` is missing

Not changed as originally proposed (serialize + create only the requested window). `proj_start` still falls back to a full `up -s` for all projects when `bots` doesn't exist; that path now goes through the same hardened `tmuxServerScope()` / `verifyStart()` logic, so it fails loudly instead of silently, but the raciness of a full `up` under concurrent `proj_start` rows is unresolved.

### P1 — Bounce leaving "session gone, scope alive"

Not implemented as a separate step. Covered indirectly: the next `up` after a bounce now goes through `decideTmuxScope()`, which correctly joins a surviving server instead of colliding with its scope, so the silent-collision failure mode is closed even without an explicit stop-if-no-other-sessions step.

### P2 — Observability

Landed via `process_health` rather than the bounce-log lines originally proposed: `tmux:bots` carries session existence, window count and scope state on every admin-daemon heartbeat (30s), and `/system` / `/monitor` render it. "0 windows" is a hard failure in the CLI's own output (`reportTmuxStart`) and in the health line, not a soft note.

### Restart concurrency (found and closed after the original proposal)

A gap not in the original list: two restarts of different names (e.g. "🔄 Bounce" then "♻️ Полный рестарт") could run concurrently, each tearing down what the other had just built, both reporting success — the per-command "already pending" check in `admin_commands` only excluded a command from itself. `utils/restart-lease.ts` closes this with a file-based mutual-exclusion lease (`O_CREAT|O_EXCL` via a staged `link`, 15-minute expiry via `LEASE_EXPIRY_MS`), taken by `claimRestart()` in `scripts/admin-daemon.ts` before `bounce`, `host_restart`, and `full_restart` spawn their detached work. A file rather than the database on purpose: the guard has to hold when the whole stack — Postgres included — is down, which is exactly when `/up` via `scripts/host-ingress.ts` is armed.

Caveat worth knowing operationally: the lease is only taken by the path through `admin_commands` — Telegram buttons and `/restart_docker`, `/restart_host`. Running `bun cli.ts bounce` directly on the host bypasses admin-daemon entirely, and with it the lease, so a host-side `bounce` can still race a Telegram-triggered restart.

---

## Manual recovery runbook (if it happens again)

```bash
# 1. Confirm Docker OK, sessions missing
docker compose -f /home/altsay/bots/helyx/docker-compose.yml ps
tmux list-sessions
systemctl --user status helyx-tmux.scope

# 2a. Prefer: create bots on existing server
tmux new-session -d -s bots -n _bootstrap -c "$HOME"
cd /home/altsay/bots/helyx && bun cli.ts up
tmux kill-window -t bots:_bootstrap 2>/dev/null || true

# 2b. Only if no valuable other tmux sessions:
# systemctl --user stop helyx-tmux.scope
# cd /home/altsay/bots/helyx && bun cli.ts up

# 3. Verify
tmux list-windows -t bots
bun cli.ts sessions
```

---

## Related files

| File | Role |
|------|------|
| `cli.ts` | `tmuxServerScope()`, `startWindow()`, `verifyTmuxStart()`, `reportTmuxStart()`, bounce |
| `sessions/tmux-server.ts` | `decideTmuxScope()` and `verifyStart()` — the pure, unit-tested logic `cli.ts` calls into; also `summarizeTmuxHost()` / `renderTmuxHealthLine()` for the `/system` panel |
| `scripts/admin-daemon.ts` | `proj_start`, `bounce`, `tmux_start`, `full_restart`, `claimRestart()` |
| `utils/restart-lease.ts` | File-based restart lease — mutual exclusion between concurrent restarts |
| `bot/commands/system.ts` | Telegram system actions |
| `/tmp/helyx-bounce.log` | Bounce stdout/stderr |
| `~/.config/systemd/user/helyx-admin.service` | Host daemon (ExecStartPost may run `helyx up`) |

---

## Verdict

- **Not a Docker problem.** Containers and webhook were healthy.
- **Sessions half failed** because stale `helyx-tmux.scope` + `systemd-run --unit=helyx-tmux` collision prevented creating `bots`.
- **False success** in CLI/admin path hid the failure from Telegram UX.
- **Recovered** by creating `bots` without systemd-run and running `helyx up`.
- **Fixed in `968fbf5`:** `tmuxServerScope()`/`decideTmuxScope()` picks the scope by server reachability instead of unit state, and start failures are no longer silent — `verifyStart()` asks tmux what actually exists and a run with zero windows is a hard failure, not a green checkmark. A separate concurrent-restart race, found afterward, is closed by the file-based restart lease in `utils/restart-lease.ts`.

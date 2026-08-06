# Restart problem: sessions not starting after full rebuild/bounce

**Date:** 2026-08-05  
**Status:** operationally recovered; root cause still present in code  
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

## Proposal: code fixes

### P0 — Make `tmuxServerScope()` actually clear collisions

Before `systemd-run --unit=helyx-tmux`:

1. If unit is **active** and session `bots` **already exists** → do not recreate scope; attach windows only (current “session exists” branch already does this).
2. If unit is **active** but session `bots` is **missing**:
   - Prefer plain `tmux new-session -d -s bots ...` when a tmux server is already reachable (`tmux list-sessions` / socket works). The server is already outside the admin service cgroup if other sessions exist.
   - Only use `systemd-run --scope --unit=helyx-tmux` when **no** tmux server is running.
3. If unit is **failed** or **dead** → keep `reset-failed` (or `stop` + `reset-failed`) then `systemd-run`.
4. Optionally: if an active scope’s main process is a zombie/orphan and no sessions remain, `systemctl --user stop helyx-tmux.scope` then recreate. Do **not** stop the scope if other sessions share that server.

Sketch:

```ts
async function tmuxServerScope(): Promise<string[]> {
  if (process.platform !== "linux") return [];
  if (!(await run(["which", "systemd-run"], { silent: true })).ok) return [];

  const hasServer = (await run(["tmux", "list-sessions"], { silent: true })).ok;
  if (hasServer) {
    // Existing server: new-session attaches without a new scope unit.
    return [];
  }

  await run(["systemctl", "--user", "stop", "helyx-tmux.scope"], { silent: true });
  await run(["systemctl", "--user", "reset-failed", "helyx-tmux.scope"], { silent: true });
  return ["systemd-run", "--user", "--scope", "--unit=helyx-tmux", "--collect", "--quiet"];
}
```

Rationale: the scope exists to keep the **first** tmux server out of `helyx-admin.service`’s cgroup. If a server is already up, a plain `tmux new-session` is correct and avoids unit name collisions.

### P0 — Fail loudly; no false green ✓

- `startWindow` / `tmuxStart` must check exit codes of `new-session` / `new-window` / `send-keys`.
- On failure: print red error, non-zero process exit (CLI), and for admin-daemon set `admin_commands.status` to a failed/error state with the real stderr (not “done” + green checkmarks).
- Bounce / full_restart completion message should refuse “всё поднято” when `tmux list-windows -t bots` count is 0 or `has-session` fails.

### P1 — `proj_start` when `bots` is missing

Today: missing session → full `up -s` for **all** projects (racey if many `proj_start` fire together). Better:

1. Ensure `bots` exists (idempotent helper shared with CLI).
2. Then create only the requested project window.
3. Serialize “ensure session” so concurrent `proj_start` rows do not all run full `up`.

### P1 — Bounce should not leave “session gone, scope alive” silent

After `tmux kill-session -t bots`:

- If no other sessions: optional stop of `helyx-tmux.scope` so the next up gets a clean unit.
- If other sessions remain: leave server; next up must use plain `new-session` (see P0).

### P2 — Observability

- Log scope state (`systemctl --user is-active helyx-tmux.scope`) and `tmux list-sessions` into bounce log before/after up.
- Surface “tmux: 0 windows” as an explicit failure in Telegram restart reports (already partially present — keep as hard fail, not soft note).

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
| `cli.ts` | `tmuxServerScope()`, `startWindow()`, `tmuxStart()`, bounce |
| `scripts/admin-daemon.ts` | `proj_start`, `bounce`, `tmux_start`, `full_restart` |
| `bot/commands/system.ts` | Telegram system actions |
| `/tmp/helyx-bounce.log` | Bounce stdout/stderr |
| `~/.config/systemd/user/helyx-admin.service` | Host daemon (ExecStartPost may run `helyx up`) |

---

## Verdict

- **Not a Docker problem.** Containers and webhook were healthy.
- **Sessions half failed** because stale `helyx-tmux.scope` + `systemd-run --unit=helyx-tmux` collision prevented creating `bots`.
- **False success** in CLI/admin path hid the failure from Telegram UX.
- **Recovered** by creating `bots` without systemd-run and running `helyx up`.
- **Still needed:** harden `tmuxServerScope()` and make start failures non-silent so the next full restart cannot leave “0 of N windows” while reporting success.

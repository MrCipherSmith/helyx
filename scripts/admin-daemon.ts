#!/usr/bin/env bun
/**
 * admin-daemon — host-side daemon that processes admin_commands from the DB.
 * Executes tmux/helyx commands on the host machine.
 *
 * Usage:
 *   bun scripts/admin-daemon.ts
 *
 * Requires DATABASE_URL env var (pointing to localhost:5433).
 * Reads from .env in the same directory if not set.
 */

import { resolve } from "path";
import { startTmuxWatchdog } from "./tmux-watchdog.ts";
import { startSupervisor } from "./supervisor.ts";
import { startTmuxSessionLogger } from "./tmux-session-logger.ts";
import { bringStackUp, type StackUpOptions } from "./stack-up.ts";
// The host half runs in restart-host-run.ts, detached — the sequence ends by
// restarting this very service, so it cannot run in this process.
import { restartDockerHalf } from "./restart-docker.ts";
import { startHostIngress } from "./host-ingress.ts";
import { summarizeTmuxHost, parseScopeState, TMUX_HEALTH_NAME } from "../sessions/tmux-server.ts";
import { parseWindowNames } from "../sessions/tmux-windows.ts";
import { runCurator, getLastCuratorRun } from "../utils/curator.ts";
import { takeRestartLease, heldMessage } from "../utils/restart-lease.ts";
import { sendCuratorSummary } from "../utils/skill-approval.ts";

const BOT_DIR = resolve(import.meta.dir, "..");
const CLI = resolve(BOT_DIR, "cli.ts");

// Load .env if DATABASE_URL not set
if (!process.env.DATABASE_URL) {
  const envFile = Bun.file(resolve(BOT_DIR, ".env"));
  if (await envFile.exists()) {
    const envText = await envFile.text();
    for (const line of envText.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error("[admin-daemon] DATABASE_URL not set");
  process.exit(1);
}

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { max: 3 });

console.log("[admin-daemon] started, polling for commands...");

// Curator cron — default: Sundays at 03:00 UTC. Supports DOW + H + M fields
// (day-of-month and month positions are ignored by design — see PRD Phase B).
const CURATOR_CRON = process.env.HELYX_CURATOR_CRON ?? "0 3 * * 0";
const [curatorMin, curatorHour, , , curatorDow] = CURATOR_CRON.split(" ");
const CURATOR_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h between runs
const CURATOR_CHECK_INTERVAL_MS = 5 * 60 * 1000; // poll every 5 min — narrows the firing window

// Persisted across restarts via curator_runs.MAX(started_at) so a crash
// in the firing window does NOT cause double-runs after restart.
let lastCuratorRunMs = 0;

async function loadLastCuratorRun(): Promise<void> {
  try {
    const row = await getLastCuratorRun();
    if (row) lastCuratorRunMs = new Date(row.started_at).getTime();
  } catch (err) {
    console.warn("[admin-daemon] failed to load last curator run:", err);
  }
}

function isCronMatch(now: Date): boolean {
  const dow = String(now.getUTCDay());
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();

  const dowOk = curatorDow === "*"
    || curatorDow === dow
    || (curatorDow.includes(",") && curatorDow.split(",").includes(dow));
  const hourOk = curatorHour === "*" || hour === parseInt(curatorHour, 10);
  // Window of CURATOR_CHECK_INTERVAL_MS / 60_000 minutes from the scheduled minute.
  const targetMin = curatorMin === "*" ? -1 : parseInt(curatorMin, 10);
  const minOk = curatorMin === "*"
    || (min >= targetMin && min < targetMin + Math.ceil(CURATOR_CHECK_INTERVAL_MS / 60_000));

  return dowOk && hourOk && minOk;
}

async function maybeRunCurator() {
  if (process.env.HELYX_CURATOR_PAUSED === "true") return;
  const now = new Date();
  if (!isCronMatch(now)) return;
  if (Date.now() - lastCuratorRunMs <= CURATOR_RUN_INTERVAL_MS) return;

  console.log("[admin-daemon] running curator...");
  lastCuratorRunMs = Date.now();
  try {
    const r = await runCurator();
    console.log("[admin-daemon] curator:", r.status, r.summary);
    const supervisorChat = process.env.SUPERVISOR_CHAT_ID;
    const supervisorTopic = process.env.SUPERVISOR_TOPIC_ID
      ? parseInt(process.env.SUPERVISOR_TOPIC_ID, 10) || undefined
      : undefined;
    if (supervisorChat) {
      await sendCuratorSummary(
        {
          examined: r.skillsExamined,
          pinned: r.skillsPinned,
          archived: r.skillsArchived,
          proposedConsolidate: r.skillsProposedConsolidate,
          proposedPatch: r.skillsProposedPatch,
          costUsd: r.auxLlmCostUsd,
          status: r.status,
          error: r.errorMessage,
        },
        supervisorChat,
        supervisorTopic,
      );
    }
  } catch (err) {
    console.error("[admin-daemon] curator error:", err);
  }
}

await loadLastCuratorRun();
setInterval(maybeRunCurator, CURATOR_CHECK_INTERVAL_MS);
// Don't fire on startup — wait for the first interval tick. Otherwise a
// daemon restart inside the firing window double-runs even with the 24h gate.

// Recover stuck commands from previous crash
await sql`UPDATE admin_commands SET status = 'pending', updated_at = now()
          WHERE status = 'processing' AND updated_at < now() - interval '5 minutes'`
  .catch(err => console.error("[admin-daemon] stuck command recovery error:", err));
console.log("[admin-daemon] stuck command recovery complete");

// Start tmux watchdog if bot token is available
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
  startTmuxWatchdog(sql, botToken);
} else {
  console.warn("[admin-daemon] TELEGRAM_BOT_TOKEN not set — tmux watchdog disabled");
}

// Start session health supervisor
startSupervisor(sql, runShell as any);
startTmuxSessionLogger(sql, runShell);

/** Where the stack lives, from this daemon's point of view. */
function stackOptions(): StackUpOptions {
  return { botDir: BOT_DIR, bunBin: Bun.which("bun") ?? process.execPath, cli: CLI };
}

// --- The host door ---
//
// Everything above reaches this daemon through `admin_commands`, which is a
// table in a container. When the stack is down that queue is unreachable and
// the daemon is a listener with nothing to listen to. This opens a direct
// Telegram poll — only while the bot is confirmed dead, because Telegram
// allows one reader per token. See scripts/host-ingress.ts.
// `TELEGRAM_CHAT_ID` is what the bot's own admin check reads, and it is absent
// from this deployment — the admin chat is configured as `SUPERVISOR_CHAT_ID`.
// Both are consulted rather than one picked, because the fallback is also the
// right destination on its own merits: the supervisor topic is where the
// "бот не отвечает" alert lands, so it is where an operator will already be
// looking when they need to type `/up`.
//
// Found by deploying: the first version keyed on `TELEGRAM_CHAT_ID` alone and
// the door came up disabled, which the log said and nothing else would have.
const adminChatId = process.env.TELEGRAM_CHAT_ID || process.env.SUPERVISOR_CHAT_ID || "";
const BOT_HEALTH_URL = `http://localhost:${process.env.PORT ?? "3847"}/health`;
if (botToken && adminChatId) {
  startHostIngress({
    run: runShell,
    stack: stackOptions(),
    token: botToken,
    adminChatId,
    // The question this probe asks is NOT "is the bot healthy" — it is "is
    // there another `getUpdates` reader on this token". Those differ, and the
    // difference is a trap: `/health` returns 503 when Postgres is down while
    // the bot process is very much alive and still long-polling Telegram
    // (mcp/server.ts:382). A probe keyed on `res.ok` would open this door
    // during a database outage, and the two readers would 409 each other while
    // the operator's messages fell between them.
    //
    // Any HTTP response at all — 200, 503, anything — proves the process is
    // there. Only a connection failure or a timeout means it is gone.
    probeBot: async () => {
      try {
        await fetch(BOT_HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
        return true;
      } catch {
        return false;
      }
    },
    telegram: async (method, body) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
  });
  console.log("[admin-daemon] host ingress armed (opens only while the bot is down)");
} else {
  console.warn("[admin-daemon] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — host ingress disabled");
}

// --- Process health heartbeat ---
// Writes admin-daemon PID + Docker container statuses to `process_health` every 30 s.
// The /monitor bot command reads from this table.
const DAEMON_START = Date.now();

async function writeProcessHealth(): Promise<void> {
  const uptimeMs = Date.now() - DAEMON_START;

  // Own heartbeat — pass object directly so postgres.js serializes it as JSONB object
  await sql`
    INSERT INTO process_health (name, status, detail, updated_at)
    VALUES ('admin-daemon', 'running', ${sql.json({ pid: process.pid, uptime_ms: uptimeMs })}, now())
    ON CONFLICT (name) DO UPDATE SET status = 'running', detail = EXCLUDED.detail, updated_at = now()
  `.catch(() => {});

  // Docker container statuses
  const dockerResult = await runShell(`timeout 10 docker ps --format "{{.Names}}\\t{{.Status}}" 2>/dev/null || true`);
  const dockerOut = dockerResult.output;
  for (const line of dockerOut.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const name = line.slice(0, tab).trim();
    const status = line.slice(tab + 1).trim();
    const running = !status.toLowerCase().startsWith("exited") && !status.toLowerCase().startsWith("dead");
    await sql`
      INSERT INTO process_health (name, status, detail, updated_at)
      VALUES (${`docker:${name}`}, ${running ? "running" : "stopped"}, ${sql.json({ status })}, now())
      ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()
    `.catch(() => {});
  }

  // The session half, from the host's point of view.
  //
  // `/system` used to describe it by counting rows in `sessions`, and during
  // the 2026-08-05 outage that counter read zero — which is equally true of a
  // session half that never started and one that started and failed to
  // register. Those need different repairs. Window count tells them apart, and
  // this is the only process with a shell on the host to go and look.
  const hasSession = await runShell(`tmux has-session -t bots 2>/dev/null`);
  const windows = hasSession.ok
    ? await runShell(`tmux list-windows -t bots -F '#{window_name}' 2>/dev/null || true`)
    : { ok: false, output: "" };
  const scope = await runShell(`systemctl --user is-active helyx-tmux.scope 2>/dev/null || true`);
  const tmuxHealth = summarizeTmuxHost({
    sessionExists: hasSession.ok,
    windowNames: [...parseWindowNames(windows.output)],
    scopeState: parseScopeState(scope.output),
  });
  await sql`
    INSERT INTO process_health (name, status, detail, updated_at)
    VALUES (${TMUX_HEALTH_NAME}, ${tmuxHealth.status}, ${sql.json(tmuxHealth.detail as any)}, now())
    ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()
  `.catch(() => {});

  // Remove entries for containers that no longer appear in `docker ps`
  const activeNames = dockerOut.split("\n").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    return tab !== -1 ? `docker:${l.slice(0, tab).trim()}` : null;
  }).filter(Boolean) as string[];

  if (activeNames.length > 0) {
    await sql`
      DELETE FROM process_health
      WHERE name LIKE 'docker:%' AND name != ALL(${activeNames})
    `.catch(() => {});
  }
}

// Write immediately on startup, then every 30 s
writeProcessHealth().catch(() => {});
let healthWriteRunning = false;
const healthInterval = setInterval(() => {
  if (healthWriteRunning) return;
  healthWriteRunning = true;
  writeProcessHealth().catch(() => {}).finally(() => { healthWriteRunning = false; });
}, 30_000);
// Prevent the interval from keeping the process alive if everything else exits
healthInterval.unref?.();

async function runCommand(cmd: string, args: string[] = []): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bun", CLI, cmd, ...args], {
    cwd: BOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { ok: proc.exitCode === 0, output: (stdout + stderr).trim() };
}

async function runShell(cmd: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: BOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { ok: proc.exitCode === 0, output: (stdout + stderr).trim() };
}

async function processCommand(row: { id: bigint; command: string; payload: any }): Promise<void> {
  // postgres.js may return JSONB as string — normalize
  const payload: Record<string, any> = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  console.log(`[admin-daemon] executing: ${row.command} ${JSON.stringify(payload)}`);
  // `deferred` means the work was handed to a detached process and is still
  // running: the row stays `processing` until that process closes it, rather
  // than going `done` a second after a restart that takes minutes started.
  // Reporting success at spawn time is what made the duplicate check useless —
  // it only refuses while a row is pending or processing, and the row stopped
  // being either almost at once. Raised in review.
  let result: { ok: boolean; output: string; deferred?: boolean };

  /**
   * Take the restart lease, or refuse.
   *
   * The three restarts exclude each other, not merely themselves: "🔄 Bounce"
   * followed by "♻️ Полный рестарт" ran two `tmux kill-session` sequences over
   * one session name, each tearing down what the other had built.
   */
  const claimRestart = (): { ok: true } | { ok: false; result: { ok: boolean; output: string } } => {
    const lease = takeRestartLease(String(row.command));
    if (!lease.ok) return { ok: false, result: { ok: false, output: heldMessage(lease.held) } };
    if (lease.broke) {
      console.error(`[admin-daemon] broke stale lease from ${lease.broke.owner}`);
    }
    return { ok: true };
  };

  try {
    switch (row.command) {
      case "tmux_start":
        result = await runCommand("up", ["-s"]);
        break;

      case "tmux_stop":
        result = await runShell("tmux kill-session -t bots 2>&1 || true");
        // Mark all remote sessions as inactive in DB
        await sql`UPDATE sessions SET status = 'inactive' WHERE source = 'remote'`;
        break;

      case "proj_start": {
        const { path } = payload;
        if (!path) { result = { ok: false, output: "missing path" }; break; }
        // Validate path to prevent shell injection (alphanumeric, /, -, _, .)
        if (!/^[a-zA-Z0-9/_.-]+$/.test(path)) {
          result = { ok: false, output: `invalid path: ${path}` }; break;
        }
        const name = path.split("/").pop() ?? path;
        // Add window to existing tmux session or start a new session
        const hasSession = await runShell("tmux has-session -t bots 2>/dev/null");
        if (hasSession.ok) {
          const wname = `${name}`;
          // Kill ALL existing windows for this project to avoid zombie accumulation.
          // tmux kill-window by name only kills the first match, so loop until all gone.
          await runShell(`while tmux kill-window -t "bots:${wname}" 2>/dev/null; do :; done`);
          // Use window index (not name) for send-keys to avoid race where the shell
          // auto-renames the window before send-keys runs.
          result = await runShell(
            `idx=$(tmux new-window -t bots -n "${wname}" -c "${path}" -P -F "#{window_index}") && ` +
            `tmux send-keys -t "bots:$idx" "${BOT_DIR}/scripts/run-cli.sh ${path}" Enter`
          );
        } else {
          result = await runCommand("up", ["-s"]);
        }
        break;
      }

      case "bounce": {
        // The same work `host_restart` does, minus the daemon step — and
        // deliberately the same code, not a second copy of it. The outage this
        // was written after came from one broken start path that four buttons
        // all reached; a repair that leaves two paths to keep in step earns the
        // same bug back later. See scripts/restart-host.ts.
        //
        // Spawned detached so the daemon survives the kill-session that tears
        // down its own window.
        const claim = claimRestart();
        if (!claim.ok) { result = claim.result; break; }
        const bunBin = Bun.which("bun") ?? process.execPath;
        const inner =
          `sleep 2; cd '${BOT_DIR}' && HELYX_RESTART_ADMIN=0 ` +
          `HELYX_RESTART_ROW=${row.id} ` +
          `'${bunBin}' '${resolve(import.meta.dir, "restart-host-run.ts")}' ` +
          `>> /tmp/helyx-bounce.log 2>&1`;
        await runShell(`nohup bash -c ${JSON.stringify(inner)} &`);
        result = { ok: true, deferred: true, output: "bounce running (log: /tmp/helyx-bounce.log)" };
        break;
      }

      case "channel_kill": {
        // Kill all channel.ts MCP subprocesses so Claude Code respawns them with fresh code.
        const killResult = await runShell(`pkill -f "bun.*helyx/channel\\.ts" 2>&1 || true`);
        result = { ok: true, output: killResult.output || "channel processes killed" };
        break;
      }

      case "docker_restart": {
        const { container } = payload as { container: string };
        if (!container) { result = { ok: false, output: "missing container" }; break; }
        // Validate container name to prevent shell injection
        if (!/^[a-zA-Z0-9_.-]+$/.test(container)) {
          result = { ok: false, output: `invalid container name: ${container}` }; break;
        }
        // Bounded like every other docker step here, and for the reason stated
        // in `stack-up.ts`: the command queue is single-threaded, so a hung
        // daemon does not merely fail this restart — it holds every command
        // behind it, including the ones an operator would reach for to recover.
        // This was the one step without a bound. Raised in review.
        const shellResult = await runShell(`timeout 240 docker restart ${container} 2>&1`);
        // `compose down` removes containers rather than stopping them, so after
        // one there is nothing named to restart and this failed with "No such
        // container" — the one situation where the operator most needs it to
        // work. `compose up -d` recreates it from the file.
        if (!shellResult.ok && /no such container/i.test(shellResult.output)) {
          const recreated = await runShell(`timeout 240 docker compose up -d 2>&1`);
          result = {
            ok: recreated.ok,
            output: `${container} was gone — recreated via compose:\n${recreated.output.trim()}`.slice(0, 2000),
          };
          break;
        }
        result = { ok: shellResult.ok, output: shellResult.output.trim() || (shellResult.ok ? `restarted ${container}` : "docker restart failed") };
        break;
      }

      case "stack_up": {
        // The recovery command: whatever half is down, bring it up. Idempotent
        // by design — see scripts/stack-up.ts.
        const stack = await bringStackUp(runShell, stackOptions());
        result = { ok: stack.ok, output: stack.summary.slice(0, 3000) };
        break;
      }

      case "docker_restart_all": {
        // The container half by name. Short enough to run inline — no rebuild,
        // so this is seconds, not the minutes `full_restart` takes.
        const docker = await restartDockerHalf(runShell, { botDir: BOT_DIR });
        result = { ok: docker.ok, output: docker.summary.slice(0, 3000) };
        break;
      }

      case "host_restart": {
        // The other half: tmux windows, the Claude process in each, their
        // channel.ts, and the daemon carrying the supervisor.
        //
        // Detached for the reason `bounce` is — the bounce tears down this
        // daemon's own tmux window, and the daemon restart at the end of the
        // sequence ends the process running it. Under `systemd-run` rather than
        // `nohup` so the work escapes this service's cgroup and survives that
        // last step; `nohup` alone does not leave the cgroup, which would kill
        // the restart halfway through and leave exactly the half-up state this
        // whole flow is about. Falls back to `nohup` where systemd-run is
        // absent, in which case the daemon step is skipped rather than run in a
        // way that would cut its own throat.
        const claim = claimRestart();
        if (!claim.ok) { result = claim.result; break; }
        const bunBin = Bun.which("bun") ?? process.execPath;
        const hasSystemdRun = (await runShell(`command -v systemd-run >/dev/null 2>&1`)).ok;
        const inner =
          `cd '${BOT_DIR}' && ` +
          `HELYX_RESTART_ADMIN=${hasSystemdRun ? "1" : "0"} ` +
          `HELYX_RESTART_ROW=${row.id} ` +
          `'${bunBin}' '${resolve(import.meta.dir, "restart-host-run.ts")}' ` +
          `>> /tmp/helyx-host-restart.log 2>&1`;
        if (hasSystemdRun) {
          await runShell(`systemd-run --user --collect --quiet bash -c ${JSON.stringify(inner)}`);
        } else {
          await runShell(`nohup bash -c ${JSON.stringify(inner)} &`);
        }
        result = {
          ok: true,
          deferred: true,
          output: hasSystemdRun
            ? "host restart running: bounce sessions → restart admin-daemon (log: /tmp/helyx-host-restart.log)"
            : "host restart running: bounce sessions (systemd-run absent — admin-daemon left alone; log: /tmp/helyx-host-restart.log)",
        };
        break;
      }

      case "full_restart": {
        // Rebuild the bot and then bounce the sessions, so new code reaches
        // both halves. Detached for the same reason `bounce` is: the bounce
        // tears down the daemon's own tmux window, and a build measured in
        // minutes would otherwise block this single-threaded command queue.
        const claim = claimRestart();
        if (!claim.ok) { result = claim.result; break; }
        const bunBin = Bun.which("bun") ?? process.execPath;
        const finish = resolve(import.meta.dir, "restart-finish.ts");
        // The finisher runs whatever the build and the bounce did — it releases
        // the lease and closes the row, and a restart that failed must not hold
        // the lease for the whole expiry.
        await runShell(
          `nohup bash -c "(cd \\"${BOT_DIR}\\"; docker compose up -d --build bot; sleep 5; \\"${bunBin}\\" \\"${CLI}\\" bounce; \\"${bunBin}\\" \\"${finish}\\" ${row.id}) >> /tmp/helyx-full-restart.log 2>&1" &`
        );
        result = { ok: true, deferred: true, output: "full restart running: rebuild bot → bounce sessions (log: /tmp/helyx-full-restart.log)" };
        break;
      }

      case "restart_admin_daemon": {
        // Mark done first, then spawn a fresh instance and exit.
        await sql`
          UPDATE admin_commands SET status = 'done', result = 'spawning replacement', executed_at = now()
          WHERE id = ${row.id as unknown as number}
        `;
        await runShell(
          `nohup bun ${resolve(import.meta.dir, "admin-daemon.ts")} >> /tmp/admin-daemon.log 2>&1 &`
        );
        console.log("[admin-daemon] replacement spawned, exiting for restart");
        await Bun.sleep(300);
        clearInterval(healthInterval);
        process.exit(0);
        break; // unreachable, but satisfies TS
      }

      case "tmux_send_keys": {
        const { project, action } = payload as { project: string; action: string };
        if (!project) { result = { ok: false, output: "missing project" }; break; }
        // Validate project name to prevent shell injection
        if (!/^[a-zA-Z0-9_-]+$/.test(project)) {
          result = { ok: false, output: `invalid project name: ${project}` }; break;
        }

        const target = `bots:${project}`;

        if (action === "esc" || action === "interrupt") {
          // Send Escape to trigger Claude's interrupt flow.
          await runShell(`tmux send-keys -t "${target}" Escape`);
          // Poll for the confirmation dialog (Enter to confirm / Esc to cancel)
          // instead of a fixed sleep — faster on fast machines, reliable on slow ones.
          const CONFIRM_RE = /enter to confirm|esc to cancel/i;
          const deadline = Date.now() + 1500;
          let confirmed = false;
          while (Date.now() < deadline) {
            await Bun.sleep(200);
            const out = await runShell(`tmux capture-pane -t "${target}" -p -S -5 2>/dev/null || true`);
            if (CONFIRM_RE.test(out.output)) {
              await runShell(`tmux send-keys -t "${target}" "" Enter`);
              confirmed = true;
              break;
            }
          }
          result = { ok: true, output: confirmed ? `Interrupted ${target} (confirmed)` : `Sent Escape to ${target}` };
        } else if (action === "close_editor") {
          // Force-close vim (:q!) — works for git commit editors opened without -m
          await runShell(`tmux send-keys -t "${target}" Escape`);
          await Bun.sleep(200);
          await runShell(`tmux send-keys -t "${target}" ':q!' Enter`);
          result = { ok: true, output: `Sent :q! to ${target}` };
        } else if (action === "btw") {
          // Send /btw side question to Claude Code — does not interrupt the main task.
          // Uses Bun.spawn with args array (not runShell) to safely pass arbitrary question text.
          const question = String(payload.question || "Что сейчас делаешь? Кратко опиши прогресс.");

          const tmuxCapture = async (): Promise<string> => {
            const p = Bun.spawn(["tmux", "capture-pane", "-t", target, "-p"], { stdout: "pipe", stderr: "pipe" });
            const out = await new Response(p.stdout).text();
            await p.exited;
            return out;
          };
          const tmuxSend = async (...keys: string[]): Promise<void> => {
            const p = Bun.spawn(["tmux", "send-keys", "-t", target, ...keys], { stdout: "pipe", stderr: "pipe" });
            await p.exited;
          };

          // 1. Baseline — lines currently visible
          const baseline = await tmuxCapture();
          const baseSet = new Set(baseline.split("\n").map(l => l.trim()).filter(Boolean));

          // 2. Open /btw overlay, then submit the question
          await tmuxSend("/btw", "Enter");
          await Bun.sleep(400);
          await tmuxSend(question, "Enter");

          // 3. Poll until response stabilises (same content for 2 consecutive 1.5s polls)
          let response = "";
          let prev = "";
          let stableCount = 0;
          const deadline = Date.now() + 25_000;

          while (Date.now() < deadline) {
            await Bun.sleep(1500);
            const current = await tmuxCapture();
            const newLines = current.split("\n")
              .map(l => l.trim())
              .filter(l => l && !baseSet.has(l))
              .filter(l => !/^[─┌┐└┘│╭╮╰╯\s]+$/.test(l))
              .filter(l => !/esc to dismiss|press esc|side question|by the way|\? for shortcuts/i.test(l));

            const content = newLines.join("\n").trim();
            if (content && content === prev) {
              stableCount++;
              if (stableCount >= 2) { response = content; break; }
            } else {
              prev = content;
              stableCount = 0;
            }
          }

          // 4. Dismiss the overlay
          await tmuxSend("Escape");

          result = { ok: true, output: response || "No response captured — overlay may not have appeared" };
        } else {
          result = { ok: false, output: `unknown action: ${action}` };
        }
        break;
      }

      case "proj_stop": {
        // eslint-disable-next-line prefer-const -- `name` is reassigned below
        let { name, project_id } = payload;
        if (!name && project_id) {
          const prows = await sql`SELECT name FROM projects WHERE id = ${project_id}`;
          if (prows.length > 0) name = prows[0].name;
        }
        if (!name) { result = { ok: false, output: "missing name" }; break; }
        // Validate name to prevent shell injection
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          result = { ok: false, output: `invalid project name: ${name}` }; break;
        }
        // Reset in-flight messages (delivered=true but Claude not yet responded) so they
        // get re-delivered to the new session after restart. Only touches messages from
        // the last 30 min — older ones were almost certainly already processed.
        if (project_id) {
          const resetResult = await sql`
            UPDATE message_queue SET delivered = false
            WHERE session_id IN (
              SELECT id FROM sessions WHERE project_id = ${project_id} AND source = 'remote'
            )
              AND delivered = true
              AND forwarded_at IS NULL
              AND created_at > NOW() - INTERVAL '30 minutes'
          `;
          if (resetResult.count > 0) {
            console.log(`[admin-daemon] proj_stop: reset ${resetResult.count} in-flight message(s) for project ${project_id}`);
          }
        }
        // Kill ALL windows for this project — tmux only kills the first match per call.
        const killResult = await runShell(`count=0; while tmux kill-window -t "bots:${name}" 2>/dev/null; do count=$((count+1)); done; echo "killed $count window(s)"`);
        result = { ok: true, output: killResult.output };
        if (project_id) {
          await sql`UPDATE sessions SET status = 'inactive' WHERE project_id = ${project_id} AND source = 'remote'`;
        } else {
          await sql`UPDATE sessions SET status = 'inactive' WHERE project = ${name} AND source = 'remote'`;
        }
        break;
      }

      case "supervisor_ack":
        // supervisor.ts reads these records directly from DB — no execution needed.
        result = { ok: true, output: "ack recorded" };
        break;

      default:
        result = { ok: false, output: `unknown command: ${row.command}` };
    }
  } catch (err: any) {
    result = { ok: false, output: err?.message ?? String(err) };
  }

  if (result.deferred) {
    // Still running. The row keeps its `processing` status — which is what the
    // enqueue-time duplicate check reads — and the detached work closes it.
    await sql`
      UPDATE admin_commands SET result = ${result.output} WHERE id = ${row.id as unknown as number}
    `;
  } else {
    await sql`
      UPDATE admin_commands
      SET status = ${result.ok ? "done" : "error"}, result = ${result.output}, executed_at = now()
      WHERE id = ${row.id as unknown as number}
    `;
  }

  console.log(`[admin-daemon] ${result.ok ? "✓" : "✗"} ${row.command}: ${result.output.slice(0, 100)}`);
}

// Main polling loop — dequeue one command at a time to guarantee order.
// The FOR UPDATE SKIP LOCKED pick-one pattern avoids concurrent execution
// of dependent commands (e.g. tmux_stop immediately followed by tmux_start).
while (true) {
  try {
    let row: any = null;
    await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, command, payload FROM admin_commands
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length > 0) {
        row = rows[0];
        await tx`UPDATE admin_commands SET status = 'processing' WHERE id = ${row.id}`;
      }
    });
    // Process after transaction commits so the lock is released before execution
    if (row) await processCommand(row as any);
  } catch (err: any) {
    console.error("[admin-daemon] poll error:", err?.message);
    await Bun.sleep(5000);
  }

  await Bun.sleep(2000);
}

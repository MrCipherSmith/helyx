/**
 * tmux Session Logger — REQ-2.1 through REQ-2.7
 *
 * Polls tmux every 10s, diffs state, logs lifecycle events to
 * logs/tmux-sessions/YYYY-MM-DD.jsonl. Runs as a sub-daemon inside admin-daemon.ts.
 *
 * CLI query mode: bun scripts/tmux-session-logger.ts --query [flags]
 */

import { resolve, join } from "path";
import { existsSync, mkdirSync, appendFileSync, readdirSync, createReadStream } from "fs";
import { createInterface } from "readline";
import type postgres from "postgres";

const BOT_DIR = resolve(import.meta.dir, "..");
const LOG_DIR = join(BOT_DIR, "logs", "tmux-sessions");

type RunShell = (cmd: string) => Promise<{ ok: boolean; output: string }>;

// ── Log event types ────────────────────────────────────────────────────────────

type EventType =
  | "session_created" | "session_destroyed"
  | "window_created" | "window_destroyed"
  | "pane_died" | "command_enqueued"
  | "snapshot" | "daemon_started" | "tmux_unavailable";

interface LogEvent {
  ts: string;
  event: EventType;
  session?: string;
  window?: string;
  window_id?: string;
  exit_code?: number;
  pane_tail?: string[] | null;
  trigger?: string;
  metadata?: Record<string, unknown>;
}

// ── File writer with daily rotation ───────────────────────────────────────────

let currentDate = "";
let currentLogPath = "";

function getLogPath(date: string): string {
  return join(LOG_DIR, `${date}.jsonl`);
}

function writeEvent(event: LogEvent): void {
  const date = new Date().toISOString().slice(0, 10);
  if (date !== currentDate) {
    currentDate = date;
    currentLogPath = getLogPath(date);
    mkdirSync(LOG_DIR, { recursive: true });
  }
  try {
    appendFileSync(currentLogPath, JSON.stringify(event) + "\n");
  } catch (err) {
    console.error("[tmux-logger] write error:", err);
  }
}

function logEvent(event: Omit<LogEvent, "ts">): void {
  writeEvent({ ts: new Date().toISOString(), ...event });
}

// ── tmux state parsing ─────────────────────────────────────────────────────────

interface TmuxSession {
  session_id: string;
  session_name: string;
  session_created: string;
  session_windows: string;
}

interface TmuxWindow {
  session_name: string;
  window_id: string;
  window_name: string;
  window_active: string;
  pane_pid: string;
  pane_dead: string;
  pane_dead_status: string;
}

function parseSessions(output: string): Map<string, TmuxSession> {
  const map = new Map<string, TmuxSession>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [session_id, session_name, session_created, session_windows] = line.split(" ");
    if (session_id) map.set(session_id, { session_id, session_name: session_name ?? "", session_created: session_created ?? "", session_windows: session_windows ?? "" });
  }
  return map;
}

function parseWindows(output: string): Map<string, TmuxWindow> {
  const map = new Map<string, TmuxWindow>();
  for (const line of output.split("\n").filter(Boolean)) {
    const parts = line.split(" ");
    const [session_name, window_id, window_name, window_active, pane_pid, pane_dead, pane_dead_status] = parts;
    if (window_id) {
      const key = `${session_name}:${window_id}`;
      map.set(key, { session_name: session_name ?? "", window_id: window_id ?? "", window_name: window_name ?? "", window_active: window_active ?? "", pane_pid: pane_pid ?? "", pane_dead: pane_dead ?? "0", pane_dead_status: pane_dead_status ?? "0" });
    }
  }
  return map;
}

async function capturePaneTail(runShell: RunShell, sessionName: string, windowName: string): Promise<string[] | null> {
  const result = await runShell(`tmux capture-pane -p -t "${sessionName}:${windowName}" -S -30 2>/dev/null || true`);
  if (!result.output.trim()) return null;
  return result.output.split("\n").filter(Boolean);
}

// ── Main daemon ────────────────────────────────────────────────────────────────

export function startTmuxSessionLogger(sql: postgres.Sql, runShell: RunShell): void {
  console.log("[tmux-logger] starting...");

  let prevSessions = new Map<string, TmuxSession>();
  let prevWindows = new Map<string, TmuxWindow>();
  let lastSeenCommandId = 0;
  let pollRunning = false;
  let snapshotRunning = false;

  // Initialize last seen command id
  sql`SELECT COALESCE(MAX(id), 0) AS max_id FROM admin_commands`
    .then((rows) => {
      lastSeenCommandId = Number((rows[0] as any)?.max_id ?? 0);
      console.log("[tmux-logger] last_seen_command_id:", lastSeenCommandId);
    })
    .catch(() => {});

  logEvent({ event: "daemon_started" });

  // Main poll — every 10s
  const pollTimer = setInterval(async () => {
    if (pollRunning) return;
    pollRunning = true;
    try {
      // Sessions
      const sessResult = await runShell("tmux list-sessions -F '#{session_id} #{session_name} #{session_created} #{session_windows}' 2>/dev/null || true");
      const winResult = await runShell("tmux list-windows -a -F '#{session_name} #{window_id} #{window_name} #{window_active} #{pane_pid} #{pane_dead} #{pane_dead_status}' 2>/dev/null || true");

      if (!sessResult.output.trim() && !winResult.output.trim()) {
        logEvent({ event: "tmux_unavailable" });
        prevSessions = new Map();
        prevWindows = new Map();
        return;
      }

      const currSessions = parseSessions(sessResult.output);
      const currWindows = parseWindows(winResult.output);

      // Detect session changes
      for (const [id, sess] of currSessions) {
        if (!prevSessions.has(id)) {
          logEvent({ event: "session_created", session: sess.session_name, metadata: { session_id: id } });
        }
      }
      for (const [id, sess] of prevSessions) {
        if (!currSessions.has(id)) {
          logEvent({ event: "session_destroyed", session: sess.session_name, metadata: { session_id: id } });
        }
      }

      // Detect window changes
      for (const [key, win] of currWindows) {
        if (!prevWindows.has(key)) {
          logEvent({ event: "window_created", session: win.session_name, window: win.window_name, window_id: win.window_id });
        }
      }
      for (const [key, win] of prevWindows) {
        if (!currWindows.has(key)) {
          // Window destroyed — capture pane tail first
          const tail = await capturePaneTail(runShell, win.session_name, win.window_name);
          logEvent({ event: "window_destroyed", session: win.session_name, window: win.window_name, window_id: win.window_id, pane_tail: tail });
        } else {
          // Check if pane died
          const curr = currWindows.get(key)!;
          if (curr.pane_dead === "1" && win.pane_dead !== "1") {
            const tail = await capturePaneTail(runShell, win.session_name, win.window_name);
            logEvent({ event: "pane_died", session: win.session_name, window: win.window_name, window_id: win.window_id, exit_code: parseInt(curr.pane_dead_status, 10) || 0, pane_tail: tail });
          }
        }
      }

      prevSessions = currSessions;
      prevWindows = currWindows;

      // Poll admin_commands for new relevant commands
      const newCmds = await sql`
        SELECT id, command, payload FROM admin_commands
        WHERE id > ${lastSeenCommandId}
          AND command IN ('proj_start', 'proj_stop', 'tmux_start', 'tmux_stop', 'bounce')
        ORDER BY id
      `.catch(() => [] as any[]);

      for (const cmd of newCmds as any[]) {
        const payload = typeof cmd.payload === "string" ? JSON.parse(cmd.payload) : (cmd.payload ?? {});
        const projectId = payload.project_id ? Number(payload.project_id) : undefined;
        logEvent({
          event: "command_enqueued",
          metadata: {
            command: cmd.command,
            command_row_id: Number(cmd.id),
            ...(projectId != null ? { project_id: projectId } : {}),
          },
        });
        if (Number(cmd.id) > lastSeenCommandId) lastSeenCommandId = Number(cmd.id);
      }
    } catch (err: any) {
      console.error("[tmux-logger] poll error:", err?.message);
    } finally {
      pollRunning = false;
    }
  }, 10_000);
  pollTimer.unref?.();

  // Snapshot — every 5 min
  const snapshotTimer = setInterval(async () => {
    if (snapshotRunning) return;
    snapshotRunning = true;
    try {
      const sessResult = await runShell("tmux list-sessions -F '#{session_id} #{session_name} #{session_created} #{session_windows}' 2>/dev/null || true");
      const winResult = await runShell("tmux list-windows -a -F '#{session_name} #{window_id} #{window_name} #{window_active} #{pane_pid} #{pane_dead} #{pane_dead_status}' 2>/dev/null || true");

      const [cmdRow] = await sql`SELECT COUNT(*) AS cnt FROM admin_commands WHERE status = 'pending'`.catch(() => [{ cnt: 0 }]);
      const [msgRow] = await sql`SELECT COUNT(*) AS cnt FROM message_queue WHERE delivered = false`.catch(() => [{ cnt: 0 }]);

      const sessions = parseSessions(sessResult.output);
      const windows = parseWindows(winResult.output);

      logEvent({
        event: "snapshot",
        metadata: {
          sessions: Array.from(sessions.values()),
          windows: Array.from(windows.values()),
          pending_commands: Number((cmdRow as any)?.cnt ?? 0),
          pending_messages: Number((msgRow as any)?.cnt ?? 0),
        },
      });
    } catch (err: any) {
      console.error("[tmux-logger] snapshot error:", err?.message);
    } finally {
      snapshotRunning = false;
    }
  }, 5 * 60_000);
  snapshotTimer.unref?.();

  console.log("[tmux-logger] running (poll:10s, snapshot:5min)");
}

// ── Query CLI (--query mode) ───────────────────────────────────────────────────

async function runQuery(): Promise<void> {
  const args = process.argv.slice(3);
  const flags: Record<string, string | boolean | string[]> = {};
  let eventFilter: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") { flags.json = true; }
    else if (a === "--include-snapshots") { flags.includeSnapshots = true; }
    else if (a === "--last" && args[i + 1]) { flags.last = args[++i]; }
    else if (a === "--since" && args[i + 1]) { flags.since = args[++i]; }
    else if (a === "--event" && args[i + 1]) { eventFilter.push(args[++i]); }
  }

  if (flags.last && flags.since) {
    console.error("Error: --last and --since are mutually exclusive");
    process.exit(1);
  }

  if (!existsSync(LOG_DIR)) {
    console.log("No log files found.");
    process.exit(0);
  }

  // Parse --last duration
  let sinceMs = 0;
  if (flags.last) {
    const match = String(flags.last).match(/^(\d+)(m|h|d)$/);
    if (!match) { console.error("Error: invalid --last format. Use e.g. 30m, 2h, 1d"); process.exit(1); }
    const n = parseInt(match[1], 10);
    const unit = match[2];
    const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    sinceMs = Date.now() - n * mult;
  } else if (flags.since) {
    sinceMs = new Date(String(flags.since)).getTime();
  }

  // Read log files
  const files = readdirSync(LOG_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .sort();

  const events: LogEvent[] = [];

  for (const file of files) {
    const filePath = join(LOG_DIR, file);
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as LogEvent;
        if (sinceMs && new Date(ev.ts).getTime() < sinceMs) continue;
        if (!flags.includeSnapshots && ev.event === "snapshot") continue;
        if (eventFilter.length > 0 && !eventFilter.includes(ev.event)) continue;
        events.push(ev);
      } catch { /* skip malformed lines */ }
    }
  }

  if (flags.json) {
    for (const ev of events) console.log(JSON.stringify(ev));
    return;
  }

  // Table output
  const COL_W = [24, 20, 12, 16, 40];
  const header = ["Timestamp", "Event", "Session", "Window", "Details"];
  const sep = COL_W.map(w => "-".repeat(w)).join(" ");
  console.log(header.map((h, i) => h.padEnd(COL_W[i])).join(" "));
  console.log(sep);

  for (const ev of events) {
    let details = "";
    if (ev.event === "pane_died") details = `exit=${ev.exit_code}`;
    else if (ev.event === "command_enqueued") details = String((ev.metadata as any)?.command ?? "");
    else if (ev.pane_tail) details = ev.pane_tail[0]?.slice(0, 38) ?? "";

    const row = [
      ev.ts.slice(0, 23),
      ev.event,
      ev.session ?? "",
      ev.window ?? "",
      details,
    ];
    console.log(row.map((v, i) => String(v).slice(0, COL_W[i]).padEnd(COL_W[i])).join(" "));
  }
}

// Entry point
if (process.argv[2] === "--query") {
  runQuery().catch(err => { console.error(err); process.exit(1); });
}

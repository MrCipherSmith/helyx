/**
 * /tmux_log — tmux session lifecycle log viewer.
 *
 * Shows a submenu with time/event filters, then reads JSONL files from
 * logs/tmux-sessions/ (mounted at /app/logs/tmux-sessions/ in Docker)
 * and returns formatted output.
 *
 * Callback prefix: tmuxlog:
 *   tmuxlog:menu        — show submenu
 *   tmuxlog:last:<d>    — query last N minutes/hours (e.g. 30m, 1h, 6h, 24h)
 *   tmuxlog:event:<e>   — filter by event type(s), comma-separated
 */

import { resolve, join } from "path";
import { existsSync, readdirSync, createReadStream } from "fs";
import { createInterface } from "readline";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

const BOT_DIR = resolve(import.meta.dir, "../..");
const LOG_DIR = join(BOT_DIR, "logs", "tmux-sessions");

interface LogEvent {
  ts: string;
  event: string;
  session?: string;
  window?: string;
  window_id?: string;
  exit_code?: number;
  pane_tail?: string[] | null;
  metadata?: Record<string, unknown>;
}

const EVENT_ICON: Record<string, string> = {
  session_created:   "🖥",
  session_destroyed: "🖥",
  window_created:    "🪟",
  window_destroyed:  "🪟",
  pane_died:         "💥",
  command_enqueued:  "📋",
  snapshot:          "📸",
  daemon_started:    "🚀",
  tmux_unavailable:  "❌",
};

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(m|h|d)$/);
  if (!m) return 60 * 60 * 1000; // default 1h
  const n = parseInt(m[1], 10);
  const mult = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function fmtTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 19) + " UTC";
}

async function queryLogs(opts: {
  sinceMs: number;
  events?: string[];
  includeSnapshots?: boolean;
  limit?: number;
}): Promise<LogEvent[]> {
  if (!existsSync(LOG_DIR)) return [];

  const files = readdirSync(LOG_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .reverse(); // newest first for traversal

  const results: LogEvent[] = [];
  const limit = opts.limit ?? 200;

  for (const file of files) {
    // Skip files older than the query window (filename is YYYY-MM-DD)
    const fileDate = new Date(file.replace(".jsonl", "") + "T00:00:00Z").getTime();
    if (fileDate + 86_400_000 < opts.sinceMs) break; // file is entirely before our window

    const lines: string[] = [];
    const rl = createInterface({ input: createReadStream(join(LOG_DIR, file)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) lines.push(line);
    }

    for (const line of lines.reverse()) {
      try {
        const ev = JSON.parse(line) as LogEvent;
        if (new Date(ev.ts).getTime() < opts.sinceMs) continue;
        if (!opts.includeSnapshots && ev.event === "snapshot") continue;
        if (opts.events && !opts.events.includes(ev.event)) continue;
        results.push(ev);
        if (results.length >= limit) return results;
      } catch { /* skip malformed */ }
    }
  }

  return results;
}

function formatEvent(ev: LogEvent): string {
  const icon = EVENT_ICON[ev.event] ?? "•";
  const time = ev.ts.slice(11, 19); // HH:MM:SS
  const where = [ev.session, ev.window].filter(Boolean).join(":");
  let detail = ev.event;

  if (ev.event === "pane_died") detail = `pane_died (exit=${ev.exit_code ?? "?"})`;
  else if (ev.event === "command_enqueued") {
    const cmd = (ev.metadata as any)?.command ?? "?";
    const pid = (ev.metadata as any)?.project_id;
    detail = pid ? `cmd: ${cmd} (proj ${pid})` : `cmd: ${cmd}`;
  }

  return `${time} ${icon} ${where ? `<b>${where}</b> — ` : ""}${detail}`;
}

function buildResultText(events: LogEvent[], label: string): string {
  if (events.length === 0) {
    return `📜 <b>Tmux Log</b> — ${label}\n\nНет событий за указанный период.`;
  }

  const lines = events.slice(0, 50).map(formatEvent);
  const header = `📜 <b>Tmux Log</b> — ${label} (последние ${events.length} событий)`;
  const body = lines.join("\n");

  return `${header}\n\n${body}${events.length > 50 ? "\n\n<i>…ещё ${events.length - 50} событий</i>" : ""}`;
}

function submenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏱ 30 мин",  "tmuxlog:last:30m").text("⏱ 1 час",    "tmuxlog:last:1h").row()
    .text("⏱ 6 часов", "tmuxlog:last:6h").text("⏱ 24 часа",  "tmuxlog:last:24h").row()
    .text("💥 Краши",   "tmuxlog:event:pane_died").text("🪟 Окна", "tmuxlog:event:window_created,window_destroyed").row()
    .text("🖥 Сессии",  "tmuxlog:event:session_created,session_destroyed").text("📋 Команды", "tmuxlog:event:command_enqueued").row()
    .text("◀️ Назад",   "menu:g:stats");
}

export async function handleTmuxLog(ctx: Context): Promise<void> {
  await ctx.reply(
    "📜 <b>Tmux Log</b>\n\nВыбери фильтр:",
    { parse_mode: "HTML", reply_markup: submenuKeyboard() },
  );
}

export async function handleTmuxLogCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1]; // "menu" | "last" | "event"

  if (action === "menu") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("📜 <b>Tmux Log</b>\n\nВыбери фильтр:", {
      parse_mode: "HTML",
      reply_markup: submenuKeyboard(),
    }).catch(() => {});
    return;
  }

  if (action === "last") {
    const duration = parts[2] ?? "1h";
    const sinceMs = Date.now() - parseDuration(duration);
    await ctx.answerCallbackQuery({ text: "Загружаю…" });
    const events = await queryLogs({ sinceMs });
    const labels: Record<string, string> = { "30m": "30 мин", "1h": "1 час", "6h": "6 часов", "24h": "24 часа" };
    const label = labels[duration] ?? duration;
    const text = buildResultText(events, label);
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: submenuKeyboard(),
    }).catch(() => {});
    return;
  }

  if (action === "event") {
    const eventTypes = (parts[2] ?? "").split(",").filter(Boolean);
    const sinceMs = Date.now() - 24 * 3_600_000; // last 24h for event filter
    await ctx.answerCallbackQuery({ text: "Загружаю…" });
    const events = await queryLogs({ sinceMs, events: eventTypes });
    const eventLabels: Record<string, string> = {
      "pane_died": "💥 Краши (24ч)",
      "window_created,window_destroyed": "🪟 Окна (24ч)",
      "session_created,session_destroyed": "🖥 Сессии (24ч)",
      "command_enqueued": "📋 Команды (24ч)",
    };
    const label = eventLabels[eventTypes.join(",")] ?? eventTypes.join(", ");
    const text = buildResultText(events, label);
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: submenuKeyboard(),
    }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

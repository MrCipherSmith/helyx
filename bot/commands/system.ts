/**
 * /system — system control panel with inline buttons for start/stop/restart.
 * Admin-only: only the configured TELEGRAM_CHAT_ID may use this.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";

function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (!adminChatId) return false; // fail closed — no config, no access
  // In DMs: chat.id === adminChatId. In forum topics: chat.id is the group id,
  // but from.id is always the user's personal id (same as DM chat id).
  return String(ctx.chat?.id) === adminChatId || String(ctx.from?.id) === adminChatId;
}

async function systemStatus(): Promise<{ lines: string[]; running: boolean; pendingCmd?: string }> {
  const [active, pending, containers] = await Promise.all([
    sql`
      SELECT COUNT(*) AS cnt
      FROM sessions
      WHERE source = 'remote' AND status = 'active' AND id != 0
    `,
    sql`
      SELECT command FROM admin_commands
      WHERE command IN ('tmux_start','tmux_stop','bounce','channel_kill','docker_restart','stack_up','full_restart')
        AND status IN ('pending','processing')
      ORDER BY created_at DESC
      LIMIT 3
    `,
    // `process_health`, written by admin-daemon every 30s — containers under
    // `docker:<name>`, the host processes under their own names.
    //
    // This read used to be `SELECT name, status FROM health_checks`, a table
    // that has never existed in any migration. The error was swallowed by the
    // `.catch` below, so the panel rendered no health lines at all and looked
    // like a system with nothing to report — while the data sat in another
    // table the whole time. A silent catch around a query is only honest when
    // the empty result means something; here it meant the section was gone.
    sql`
      SELECT name, status, updated_at FROM process_health
      ORDER BY name
    `.catch(() => [] as any[]),
  ]);

  const running = Number(active[0]?.cnt ?? 0) > 0;
  const pendingCmds = (pending as any[]).map((r) => r.command as string);
  const pendingCmd = pendingCmds[0];

  const lines: string[] = ["🖥 System control\n"];

  if (pendingCmds.length > 0) {
    lines.push(`⏳ Pending: ${pendingCmds.join(", ")}`);
  } else if (running) {
    lines.push(`🟢 Sessions: ${Number(active[0]?.cnt ?? 0)} active`);
  } else {
    lines.push("🔴 Sessions: not running");
  }

  lines.push(...renderHealthLines(containers as HealthRow[], Date.now()));

  return { lines, running, pendingCmd };
}

export interface HealthRow {
  name: string;
  status: string | null;
  updated_at: string | Date | null;
}

/**
 * A heartbeat older than this is not a status, it is the last thing that was
 * true. The writer runs every 30s, so 90s is three missed beats.
 */
export const HEALTH_STALE_MS = 90_000;

/**
 * Which rows the panel shows.
 *
 * `process_health` also carries every other container on the host — the daemon
 * writes whatever `docker ps` returns — and a control panel listing a dozen
 * unrelated containers is one nobody reads. Ours are the compose project's, plus
 * the two host processes that have no container at all.
 */
export const HOST_PROCESSES = ["admin-daemon", "supervisor"] as const;

/**
 * The health section, as lines.
 *
 * Pure and exported because the panel had a whole section that silently
 * rendered nothing for its entire life, and the only way that is caught is by
 * being able to ask what it renders without a bot and a database behind it.
 */
export function renderHealthLines(
  rows: readonly HealthRow[],
  now: number,
  composeProject = process.env.COMPOSE_PROJECT_NAME ?? "helyx",
): string[] {
  const out: string[] = [];

  for (const name of HOST_PROCESSES) {
    const row = rows.find((r) => r.name === name);
    if (!row) {
      out.push(`❔ ${name}: нет данных`);
      continue;
    }
    out.push(`${icon(row, now)} ${name}: ${describe(row, now)}`);
  }

  const containers = rows.filter((r) => r.name.startsWith(`docker:${composeProject}`));
  for (const row of containers) {
    out.push(`${icon(row, now)} ${row.name.slice("docker:".length)}: ${describe(row, now)}`);
  }
  if (containers.length === 0) {
    out.push("❔ контейнеры: нет данных");
  }

  return out;
}

function isStale(row: HealthRow, now: number): boolean {
  if (!row.updated_at) return true;
  return now - new Date(row.updated_at).getTime() > HEALTH_STALE_MS;
}

function isUp(row: HealthRow): boolean {
  const status = String(row.status ?? "").toLowerCase();
  return status === "running" || status === "ok" || status === "healthy";
}

function icon(row: HealthRow, now: number): string {
  if (isStale(row, now)) return "🟡";
  return isUp(row) ? "✅" : "⚠️";
}

function describe(row: HealthRow, now: number): string {
  const status = row.status ?? "unknown";
  return isStale(row, now) ? `${status} (нет свежего heartbeat)` : String(status);
}

export async function handleSystem(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply("⛔ Admin only.");
    return;
  }

  const { lines, running, pendingCmd } = await systemStatus();
  const kb = buildKeyboard(running, !!pendingCmd);
  await ctx.reply(lines.join("\n"), { reply_markup: kb, parse_mode: "HTML" });
}

function buildKeyboard(running: boolean, busy: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!busy) {
    if (running) {
      kb.text("🛑 Stop", "sys:stop").text("🔄 Bounce", "sys:bounce");
    } else {
      kb.text("▶️ Start", "sys:start");
    }
    kb.row();
    kb.text("🐳 Restart bot", "sys:restart_bot").text("⚡ Kill channels", "sys:channel_kill");
    // The two that were missing, and whose absence is what made a "restart"
    // mean one half of the system. "Поднять всё" starts whatever is down and
    // leaves what is running alone; "Полный рестарт" rebuilds the bot and then
    // bounces the sessions, so new code reaches both halves.
    kb.row();
    kb.text("🚀 Поднять всё", "sys:stack_up").text("♻️ Полный рестарт", "sys:full_restart");
  }
  kb.row().text("🔄 Refresh", "sys:refresh");
  return kb;
}

export async function handleSystemCallback(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "Admin only" });
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  const action = data.slice("sys:".length);

  if (action === "refresh") {
    await ctx.answerCallbackQuery({ text: "Refreshed" });
    await ctx.deleteMessage().catch(() => {});
    await handleSystem(ctx);
    return;
  }

  const cmdMap: Record<string, { command: string; payload?: Record<string, unknown>; label: string }> = {
    start:        { command: "tmux_start",    payload: {},                                label: "▶️ Starting..." },
    stop:         { command: "tmux_stop",     payload: {},                                label: "🛑 Stopping..." },
    bounce:       { command: "bounce",        payload: {},                                label: "🔄 Bouncing sessions..." },
    restart_bot:  { command: "docker_restart", payload: { container: "helyx-bot-1" },    label: "🐳 Restarting bot..." },
    channel_kill: { command: "channel_kill",  payload: {},                                label: "⚡ Killing channels..." },
    stack_up:     { command: "stack_up",      payload: {},                                label: "🚀 Поднимаю всё..." },
    full_restart: { command: "full_restart",  payload: {},                                label: "♻️ Полный рестарт..." },
  };

  const entry = cmdMap[action];
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  const already = await sql`
    SELECT id FROM admin_commands
    WHERE command = ${entry.command} AND status IN ('pending','processing')
    LIMIT 1
  `;
  if (already.length > 0) {
    await ctx.answerCallbackQuery({ text: "Already in progress..." });
    return;
  }

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES (${entry.command}, ${sql.json((entry.payload ?? {}) as any)})
  `;

  await ctx.answerCallbackQuery({ text: entry.label });
  await ctx.editMessageText(`${entry.label}\n\nUse 🔄 Refresh to check status.`, {
    reply_markup: new InlineKeyboard().text("🔄 Refresh", "sys:refresh"),
    parse_mode: "HTML",
  });
}

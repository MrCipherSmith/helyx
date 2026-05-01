/**
 * /system — system control panel with inline buttons for start/stop/restart.
 * Admin-only: only the configured TELEGRAM_CHAT_ID may use this.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";

function isAdmin(ctx: Context): boolean {
  const adminChatId = String(process.env.TELEGRAM_CHAT_ID ?? "");
  return !adminChatId || String(ctx.chat?.id) === adminChatId;
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
      WHERE command IN ('tmux_start','tmux_stop','bounce','channel_kill','docker_restart')
        AND status IN ('pending','processing')
      ORDER BY created_at DESC
      LIMIT 3
    `,
    sql`
      SELECT name, status FROM health_checks
      WHERE name IN ('bot','admin-daemon')
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

  for (const c of containers as any[]) {
    const ok = String(c.status ?? "").toLowerCase().includes("ok") || String(c.status ?? "") === "healthy";
    lines.push(`${ok ? "✅" : "⚠️"} ${c.name}: ${c.status ?? "unknown"}`);
  }

  return { lines, running, pendingCmd };
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

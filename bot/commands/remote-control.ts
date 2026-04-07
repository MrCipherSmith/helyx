import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";
import { sessionDisplayName } from "../../sessions/manager.ts";

export async function handleRemoteControl(ctx: Context): Promise<void> {
  const active = await sql`
    SELECT id, name, project, source, last_active
    FROM sessions
    WHERE source = 'remote' AND status = 'active' AND id != 0
    ORDER BY last_active DESC
  `;

  const running = active.length > 0;
  const lines: string[] = [];

  if (running) {
    lines.push(`🟢 tmux bots — running (${active.length} sessions)`);
    lines.push("");
    for (const s of active) {
      const ago = Math.round((Date.now() - new Date(s.last_active).getTime()) / 1000);
      const agoStr = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
      lines.push(`• ${s.project} · ${s.source} — ${agoStr} ago`);
    }
  } else {
    lines.push("🔴 tmux bots — not running");
  }

  const kb = new InlineKeyboard();
  if (running) {
    kb.text("🛑 Kill", "rc:kill");
  } else {
    kb.text("▶️ Start", "rc:start");
  }
  kb.text("🔄 Refresh", "rc:refresh");

  await ctx.reply(lines.join("\n"), { reply_markup: kb });
}

export async function handleRemoteControlCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const action = data.slice("rc:".length);

  if (action === "refresh") {
    await ctx.answerCallbackQuery({ text: "Refreshed" });
    await ctx.deleteMessage().catch(() => {});
    await handleRemoteControl(ctx);
    return;
  }

  if (action === "kill" || action === "start") {
    await sql`
      INSERT INTO admin_commands (command, payload)
      VALUES (${action === "kill" ? "tmux_stop" : "tmux_start"}, '{}')
    `;
    await ctx.answerCallbackQuery({ text: action === "kill" ? "Kill command queued" : "Start command queued" });
    await ctx.editMessageText(
      action === "kill" ? "⏳ Stopping tmux bots..." : "⏳ Starting tmux bots...",
      { reply_markup: new InlineKeyboard().text("🔄 Refresh", "rc:refresh") }
    );
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

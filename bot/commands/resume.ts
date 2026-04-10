/**
 * /resume — restores the last session summary into the active Claude session.
 *
 * Use /summarize before restarting tmux to save context.
 * After restarting and starting a new Claude session, use /resume to inject
 * the saved summary into the message queue so Claude can pick up where it left off.
 */

import type { Context } from "grammy";
import { sessionManager } from "../../sessions/manager.ts";
import { sql } from "../../memory/db.ts";
import { messageService } from "../../services/index.ts";

export async function handleResume(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const sessionId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(sessionId);

  if (!session || session.status !== "active") {
    await ctx.reply("No active session. Start a Claude session first.");
    return;
  }

  const projectPath = session.projectPath ?? null;

  // Find the most recent summary for this project (or any session for this chat)
  const rows = await sql`
    SELECT content, type, created_at
    FROM memories
    WHERE (${projectPath ? sql`project_path = ${projectPath}` : sql`project_path IS NULL`}
           OR chat_id = ${chatId})
      AND type IN ('summary', 'project_context')
      AND archived_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) {
    await ctx.reply(
      "No saved context found.\n\nRun /summarize before restarting to save the current session context.",
    );
    return;
  }

  const { content, created_at } = rows[0];
  const age = Math.round((Date.now() - new Date(created_at).getTime()) / 60_000);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

  const injectedMessage =
    `[Context restored from last session (${ageStr})]\n\n${content}\n\n` +
    `You're starting fresh. Briefly acknowledge this context and confirm you're ready to continue.`;

  await messageService.queue({
    sessionId,
    chatId,
    fromUser: "system",
    content: injectedMessage,
  });

  await ctx.reply(`Context injected (${ageStr}). Claude will process it shortly.`);
}

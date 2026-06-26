/**
 * /prepare_restart — snapshot context in all active sessions before a redeploy.
 *
 * For each active CLI session, injects a message asking Claude to write a
 * RESTART_CONTEXT.md in the project root with current tasks, plan, and status.
 * After restart, the file is read by the session (or manually reviewed) to
 * restore context beyond what the database holds.
 */

import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";

const SAVE_PROMPT = `SYSTEM: Pre-restart context snapshot requested by admin.

Please create or update the file RESTART_CONTEXT.md in the root of this project directory right now. Include:
1. What task or feature you are currently working on (in 2-3 sentences)
2. What has been completed so far in this session
3. What the next concrete step is
4. Any blockers or open questions
5. Files you have modified (if any)

Keep it concise — it is a recovery document, not a report. Write it immediately, then reply "Context saved to RESTART_CONTEXT.md".`;

interface ActiveSession {
  id: number;
  project: string;
  project_path: string | null;
  project_id: number | null;
  last_active: string | null;
}

export async function handlePrepareRestart(ctx: Context): Promise<void> {
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (!adminChatId) {
    await ctx.reply("⚠️ TELEGRAM_CHAT_ID not set — cannot route responses back.");
    return;
  }

  const sessions = await sql<ActiveSession[]>`
    SELECT s.id, s.project, s.project_path, s.project_id, s.last_active
    FROM sessions s
    WHERE s.status = 'active' AND s.id != 0
    ORDER BY s.project
  `;

  if (sessions.length === 0) {
    await ctx.reply("ℹ️ Нет активных сессий — нечего сохранять.");
    return;
  }

  const results: string[] = [`🔄 <b>Prepare to Restart</b> — снимок контекста\n`];
  let sent = 0;

  for (const session of sessions) {
    const msgId = `prepare-restart-${Date.now()}-${session.id}`;
    try {
      await sql`
        INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
        VALUES (${session.id}, ${adminChatId}, ${"system"}, ${SAVE_PROMPT}, ${msgId})
        ON CONFLICT (chat_id, message_id) DO NOTHING
      `;
      results.push(`✅ <b>${session.project}</b> — команда отправлена`);
      sent++;
    } catch (err) {
      results.push(`❌ <b>${session.project}</b> — ошибка: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  results.push(`\n<i>Отправлено ${sent} из ${sessions.length} сессий. Каждая создаст RESTART_CONTEXT.md в корне проекта.</i>`);
  await ctx.reply(results.join("\n"), { parse_mode: "HTML" });
}

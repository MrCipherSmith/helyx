/**
 * Recovery helpers — called at bot startup to handle stale state from crashed processes.
 *
 * recoverStaleStatusMessages: edits zombie Telegram status messages to "⚠️ Бот перезапущен"
 * deliverPendingReplies: sends replies that were buffered to DB but not yet delivered
 */

import type postgres from "postgres";
import { editTelegramMessage, sendTelegramMessage } from "./telegram.ts";
import { markdownToTelegramHtml } from "../bot/format.ts";
import { channelLogger } from "../logger.ts";


function formatElapsed(startedAt: Date): string {
  const sec = Math.round((Date.now() - startedAt.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/**
 * Find active_status_messages with no heartbeat for >2 min (channel crashed).
 * Edit each to "⚠️ Бот перезапущен · Xm Ys" and delete the record.
 */
export async function recoverStaleStatusMessages(sql: postgres.Sql, token: string): Promise<void> {
  try {
    const rows = await sql`
      SELECT key, chat_id, thread_id, message_id, started_at, project_name
      FROM active_status_messages
      WHERE updated_at < NOW() - INTERVAL '2 minutes'
    `;

    if (rows.length === 0) return;

    channelLogger.info({ count: rows.length }, "recovering stale status messages");

    for (const row of rows) {
      const elapsed = formatElapsed(new Date(row.started_at));
      const editRes = await editTelegramMessage(
        token,
        row.chat_id,
        row.message_id,
        `⚠️ Бот перезапущен · <i>${elapsed}</i>`,
        { parse_mode: "HTML" },
      );

      if (!editRes.ok) {
        channelLogger.warn({ project: row.project_name, error: editRes.errorBody }, "stale status edit failed");
      }

      await sql`DELETE FROM active_status_messages WHERE key = ${row.key}`;
      channelLogger.info({ project: row.project_name, chatId: row.chat_id }, "stale status message cleared");
    }
  } catch (err) {
    channelLogger.warn({ err }, "recoverStaleStatusMessages error");
  }
}

/**
 * Find voice_status_messages older than 5 min (bot crashed during download/transcription).
 * Edit each to "⚠️ Бот перезапущен" and delete the record.
 */
export async function recoverStaleVoiceStatusMessages(sql: postgres.Sql, token: string): Promise<void> {
  try {
    const rows = await sql`
      SELECT id, chat_id, thread_id, message_id
      FROM voice_status_messages
      WHERE created_at < NOW() - INTERVAL '5 minutes'
    `;

    if (rows.length === 0) return;

    channelLogger.info({ count: rows.length }, "recovering stale voice status messages");

    for (const row of rows) {
      await editTelegramMessage(
        token,
        row.chat_id,
        row.message_id,
        `⚠️ Бот перезапущен — голосовое не обработано. Отправь повторно.`,
      ).catch(() => {});
      await sql`DELETE FROM voice_status_messages WHERE id = ${row.id}`;
    }
  } catch (err) {
    channelLogger.warn({ err }, "recoverStaleVoiceStatusMessages error");
  }
}

/**
 * Find pending_replies with no delivered_at (Telegram send failed or bot was down).
 * Retry delivery for each.
 */
export async function deliverPendingReplies(sql: postgres.Sql, token: string): Promise<void> {
  try {
    const rows = await sql`
      SELECT id, chat_id, thread_id, text
      FROM pending_replies
      WHERE delivered_at IS NULL
        AND created_at < NOW() - INTERVAL '30 seconds'
      ORDER BY created_at ASC
    `;

    if (rows.length === 0) return;

    channelLogger.info({ count: rows.length }, "delivering pending replies");

    for (const row of rows) {
      const htmlText = markdownToTelegramHtml(String(row.text));
      const extra: Record<string, unknown> = {};
      if (row.thread_id) extra.message_thread_id = row.thread_id;

      // Try HTML, fall back to plain text
      let res = await sendTelegramMessage(token, row.chat_id, htmlText, { parse_mode: "HTML", ...extra });
      if (!res.ok && res.errorBody?.includes("can't parse entities")) {
        res = await sendTelegramMessage(token, row.chat_id, String(row.text), extra);
      }

      if (res.ok) {
        await sql`UPDATE pending_replies SET delivered_at = NOW() WHERE id = ${row.id}`;
        channelLogger.info({ id: row.id, chatId: row.chat_id }, "pending reply delivered");
      } else {
        channelLogger.warn({ id: row.id, error: res.errorBody }, "pending reply delivery failed");
      }
    }
  } catch (err) {
    channelLogger.warn({ err }, "deliverPendingReplies error");
  }
}

/**
 * Recovery helpers — called at bot startup to handle stale state from crashed processes.
 *
 * recoverStaleStatusMessages: edits zombie Telegram status messages to "⚠️ Бот перезапущен"
 * deliverPendingReplies: sends replies that were buffered to DB but not yet delivered
 */

import type postgres from "postgres";
import { editTelegramMessage, sendTelegramMessage, sendRichTelegramMessage } from "./telegram.ts";
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
 * Find pending_replies not yet fully delivered (status pending/failed/partial,
 * plus 'sending' once it has sat for the same 30s bound below — see flow 065
 * AC5 review) and retry delivery for each.
 *
 * 'sending' is included, not excluded: a row a live process just premarked
 * moments ago is filtered out by the same `created_at` age bound every other
 * status here already uses, so a genuinely in-flight send elsewhere is not
 * double-sent. What the age bound *does* catch is the crash this flow exists
 * to fix — a process that dies between premarking 'sending' and ever calling
 * `markPendingOutcome` leaves the row stuck at 'sending' forever with nothing
 * else able to move it, since no other write path ever revisits that status.
 * See docs/report/helyx-telegram-delivery-incident/2026-09-02-report.md
 * section 9 and flow 065's review findings for T4.
 *
 * Called once at bot startup (`main.ts`) and, since flow 065 AC4, again on a
 * bounded interval by `startPendingReplyRecoveryWorker` below — a reply that
 * lands here no longer waits for the bot to restart before it is retried.
 */
export async function deliverPendingReplies(sql: postgres.Sql, token: string): Promise<void> {
  try {
    const rows = await sql`
      SELECT id, chat_id, thread_id, text
      FROM pending_replies
      WHERE status IN ('pending', 'failed', 'partial', 'sending')
        AND created_at < NOW() - INTERVAL '30 seconds'
      ORDER BY created_at ASC
    `;

    if (rows.length === 0) return;

    channelLogger.info({ count: rows.length }, "delivering pending replies");

    for (const row of rows) {
      const extra: Record<string, unknown> = {};
      if (row.thread_id) extra.message_thread_id = row.thread_id;

      // Try rich → HTML → plain (same chain as reply tool)
      let res = await sendRichTelegramMessage(token, row.chat_id, String(row.text), extra);
      if (!res.ok) {
        channelLogger.info({ error: res.errorBody }, "pending reply: rich failed, trying HTML");
        const htmlText = markdownToTelegramHtml(String(row.text));
        res = await sendTelegramMessage(token, row.chat_id, htmlText, { parse_mode: "HTML", ...extra });
        if (!res.ok && res.errorBody?.includes("can't parse entities")) {
          res = await sendTelegramMessage(token, row.chat_id, String(row.text), extra);
        }
      }

      if (res.ok) {
        await sql`UPDATE pending_replies SET delivered_at = NOW(), status = 'delivered' WHERE id = ${row.id}`;
        channelLogger.info({ id: row.id, chatId: row.chat_id }, "pending reply delivered");
      } else {
        await sql`UPDATE pending_replies SET status = 'failed' WHERE id = ${row.id}`.catch(() => {});
        channelLogger.warn({ id: row.id, error: res.errorBody }, "pending reply delivery failed");
      }
    }
  } catch (err) {
    channelLogger.warn({ err }, "deliverPendingReplies error");
  }
}

/**
 * Start a periodic worker that retries stuck `pending_replies` rows on a
 * bounded interval, independent of bot process startup.
 *
 * Before flow 065 AC4, `deliverPendingReplies` only ran once, from `main.ts`'s
 * startup sequence — a reply that landed in `pending_replies` and then failed
 * (rate-limit timeout, transient Telegram error, process hiccup) stayed
 * invisible until the bot happened to restart. See
 * docs/report/helyx-telegram-delivery-incident/2026-09-02-report.md section 9
 * and section 3's timeline: two replies sat there for 10-11 minutes.
 *
 * `intervalMs` defaults to something sane in production (45s — within the
 * report's 30-60s guidance) but is overridable for tests, which need ticks far
 * shorter than that to stay fast.
 */
export function startPendingReplyRecoveryWorker(
  sql: postgres.Sql,
  token: string,
  options?: { intervalMs?: number },
): { stop: () => void } {
  const intervalMs = options?.intervalMs ?? 45_000;
  let running = false;

  const timer = setInterval(() => {
    // A tick that finds the previous one still in flight (a slow Telegram
    // round-trip, a burst of stale rows) skips rather than overlaps it —
    // `deliverPendingReplies` is not designed to be re-entered concurrently
    // against the same rows.
    if (running) return;
    running = true;
    deliverPendingReplies(sql, token)
      .catch((err) => channelLogger.warn({ err }, "startPendingReplyRecoveryWorker: tick failed"))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // Never keep the process alive solely for this timer.
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    stop: () => clearInterval(timer),
  };
}

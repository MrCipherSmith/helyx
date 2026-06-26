/**
 * MessageQueuePoller — LISTEN/NOTIFY + polling loop.
 */

import type postgres from "postgres";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StatusManager } from "./status.ts";
import type { SkillEvaluator } from "./skill-evaluator.ts";
import { channelLogger } from "../logger.ts";
import { setTelegramReaction } from "./telegram.ts";
import { getProjectHistory } from "../memory/short-term.ts";
import { sessionManager } from "../sessions/manager.ts";

const DEADLINE_EXCEEDED = Symbol("deadline_exceeded");
const CONTEXT_INJECT_LIMIT = Number(process.env.CONTEXT_INJECT_LIMIT ?? 15);

type ContextTier = "summary" | "raw";
interface ContextBlock { content: string; tier: ContextTier; messageCount?: number }

async function buildContextBlock(
  projectPath: string,
  chatId: string,
  sql: postgres.Sql,
): Promise<ContextBlock | null> {
  // Tier 1: most recent summary or project_context from long-term memory.
  // project_context rows are stored with chatId='' (summarizeWork has no chatId param),
  // so they need a separate OR branch; summary rows use the real chatId.
  const rows = await sql`
    SELECT content, type
    FROM memories
    WHERE project_path = ${projectPath}
      AND (
        (chat_id = ${chatId} AND type IN ('summary', 'project_context'))
        OR (chat_id = '' AND type = 'project_context')
      )
      AND archived_at IS NULL
    ORDER BY created_at DESC,
             CASE WHEN type = 'project_context' THEN 0 ELSE 1 END
    LIMIT 1
  `;

  if (rows.length > 0) {
    return {
      content: `[Session context from prior conversation]\n${rows[0].content}\n[End context]`,
      tier: "summary",
    };
  }

  // Tier 2: raw recent messages cross-session for this project+chat.
  const messages = await getProjectHistory(projectPath, chatId, CONTEXT_INJECT_LIMIT);
  if (messages.length === 0) return null;

  const lines = messages.map((m) => {
    const preview = m.content.length > 200 ? m.content.slice(0, 197) + "…" : m.content;
    return `${m.role}: ${preview}`;
  });

  return {
    content: `[Session context from prior conversation]\n${lines.join("\n")}\n[End context]`,
    tier: "raw",
    messageCount: messages.length,
  };
}

/** Run a promise with a deadline. Resolves to DEADLINE_EXCEEDED and logs a warning if ms elapses first. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T | typeof DEADLINE_EXCEEDED> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timerId = setTimeout(() => {
      channelLogger.warn({ label, ms }, "poller: deadline exceeded, continuing");
      resolve(DEADLINE_EXCEEDED);
    }, ms);
  });
  // Cancel the timer when p settles first so the warning only fires on genuine deadline violations.
  const guardedP = p.finally(() => clearTimeout(timerId));
  return Promise.race([guardedP, timeoutPromise]);
}

export interface PollerContext {
  sql: postgres.Sql;
  mcp: Server;
  sessionId: () => number | null;
  pollIntervalMs: number;
  databaseUrl: string;
  /** Called after each dequeue to tell tools whether to force a voice reply */
  setForceVoice?: (v: boolean) => void;
  /** Telegram bot token — used to set ⚡ reaction when message is taken into work */
  token?: () => string | undefined;
  /** Called with the Telegram message_id when the poller dequeues a message — lets
   *  the reply tool know which original message to mark ✅ after Claude responds */
  setIncomingTgMsgId?: (chatId: string, msgId: number | null) => void;
}

export class MessageQueuePoller {
  private polling = true;
  private wakeResolve: (() => void) | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private listenSql: postgres.Sql | null = null;
  /**
   * Chats whose pending message was skipped because Claude was mid-turn.
   * Drained when the chat becomes free and we deliver the deferred row —
   * the first delivery for such a chat gets a "+ Догнал ещё один вопрос"
   * status prefix so the user sees a clean turn boundary.
   */
  private deferredChats = new Set<string>();
  /**
   * Tracks sessions that already received a context injection this process run.
   * Key: "sessionId:clientId" — resets automatically when the channel process restarts
   * or when Claude Code reconnects (clientId changes on each new process).
   */
  private injectedSessions = new Set<string>();

  constructor(
    private ctx: PollerContext,
    private status: StatusManager,
    private touchIdleTimer: () => void,
    private skillEvaluator?: SkillEvaluator,
  ) {}

  private async setupListenNotify(): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (sessionId === null) return;
    try {
      const { default: postgres } = await import("postgres");
      this.listenSql = postgres(this.ctx.databaseUrl, {
        max: 1,
        onclose: () => {
          if (this.polling) {
            channelLogger.warn("LISTEN connection closed — reconnecting in 5s");
            this.listenSql = null;
            setTimeout(() => {
              if (this.polling) this.setupListenNotify().catch(() => {});
            }, 5_000);
          }
        },
      });
      const listenSql = this.listenSql;
      await listenSql.listen(`message_queue_${sessionId}`, () => {
        if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
        if (this.wakeResolve) { this.wakeResolve(); this.wakeResolve = null; }
      });
      channelLogger.info({ sessionId }, "LISTEN/NOTIFY active");
    } catch (err) {
      channelLogger.warn({ err }, "LISTEN/NOTIFY setup failed, falling back to polling");
    }
  }

  private waitForWakeOrTimeout(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.wakeResolve = null;
        resolve();
      }, this.ctx.pollIntervalMs);
    });
  }

  stop(): void {
    this.polling = false;
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
    if (this.wakeResolve) { this.wakeResolve(); this.wakeResolve = null; }
    this.listenSql?.end().catch(() => {});
    this.listenSql = null;
  }

  async start(): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (sessionId !== null) await this.setupListenNotify();

    while (this.polling) {
      try {
        const sid = this.ctx.sessionId();
        if (sid === null) {
          await new Promise((r) => setTimeout(r, this.ctx.pollIntervalMs));
          continue;
        }

        // FOR UPDATE SKIP LOCKED: concurrent pollers (e.g. from rapid Stop/Start
        // cycles that leave multiple channel.ts instances alive for the same session)
        // skip already-locked rows instead of racing on the same IDs.
        // Without this, two pollers evaluating the subquery at the same MVCC snapshot
        // could both get the same ID, then both UPDATE it (outer WHERE re-checks id only,
        // not delivered=false), causing duplicate deliveries.
        // chat_id != ALL(busyChats): defer delivery for chats with an open status —
        // the next user message stays delivered=false until the current turn ends, so
        // each turn gets its own status/typing cycle instead of being merged inline.
        const busyChats = Array.from(this.status.getBusyChats());
        if (busyChats.length > 0) {
          // Track which busy chats have at least one pending message so we can
          // mark the first delivery as "carried over" once the chat frees up.
          const pending = await this.ctx.sql`
            SELECT DISTINCT chat_id FROM message_queue
            WHERE session_id = ${sid} AND delivered = false
              AND chat_id = ANY(${busyChats})
          `;
          for (const r of pending) this.deferredChats.add(r.chat_id);
        }
        const rows = busyChats.length === 0
          ? await this.ctx.sql`
              UPDATE message_queue
              SET delivered = true
              WHERE id IN (
                SELECT id FROM message_queue
                WHERE session_id = ${sid} AND delivered = false
                ORDER BY created_at
                LIMIT 10
                FOR UPDATE SKIP LOCKED
              )
              RETURNING id, chat_id, from_user, content, message_id, created_at, attachments
            `
          : await this.ctx.sql`
              UPDATE message_queue
              SET delivered = true
              WHERE id IN (
                SELECT id FROM message_queue
                WHERE session_id = ${sid} AND delivered = false
                  AND chat_id != ALL(${busyChats})
                ORDER BY created_at
                LIMIT 10
                FOR UPDATE SKIP LOCKED
              )
              RETURNING id, chat_id, from_user, content, message_id, created_at, attachments
            `;

        // For batches of rows from the same chat, the FIRST row's status creation
        // sets the stage; subsequent edits in the batch would overwrite it. Mark the
        // whole batch as carried-over (per chat) so all sendStatusMessage calls in
        // this iteration agree on the prefix.
        const carriedOverChats = new Set<string>();
        for (const row of rows) {
          if (this.deferredChats.has(row.chat_id)) {
            carriedOverChats.add(row.chat_id);
            this.deferredChats.delete(row.chat_id);
          }
        }

        // Fetch session once per batch — sid is constant for the entire while-iteration.
        // Used to build the injection key and look up projectPath for context injection.
        const sessionInfo = rows.length > 0
          ? await sessionManager.get(sid).catch(() => null)
          : null;
        const injectionKey = `${sid}:${sessionInfo?.clientId ?? ""}`;

        // Tracks chats that already had their old status deleted in this batch.
        // For burst batches (multiple messages queued for the same chat), skip
        // deleteStatusMessage on 2nd+ rows so the status created by the first row
        // survives — sendStatusMessage updates it in-place instead of flashing 3ms.
        const processedChats = new Set<string>();

        for (const row of rows) {
          const tDequeue = Date.now();
          const queueAge = tDequeue - new Date(row.created_at).getTime();
          channelLogger.info({ phase: "poller", step: "dequeued", msgId: row.id, sessionId: sid, chatId: row.chat_id, queueAgeMs: queueAge, t: tDequeue }, "perf");

          const hint = this.skillEvaluator?.buildHint(row.content) ?? "";
          const isVoiceMsg = !!(row.attachments as Record<string, unknown> | null)?.isVoice;
          this.ctx.setForceVoice?.(isVoiceMsg);
          // Always prepend TTS awareness note so Claude knows voice is automatic
          const ttsNote = isVoiceMsg
            ? "[Channel system: The user sent a voice message. ALWAYS send a voice reply regardless of length — it is sent automatically after reply, you do NOT need to do anything extra.]\n"
            : "[Channel system: Replies ≥300 chars are automatically sent as a voice message after you call reply — you do NOT need to do anything extra, and you CAN send voice (automatically). Never claim you cannot.]\n";

          // Inject prior-session context into the first message delivered to a fresh session.
          // The key includes clientId so the guard resets on every new Claude Code process.
          let contextPrefix = "";
          if (sessionInfo?.projectPath && !this.injectedSessions.has(injectionKey)) {
            this.injectedSessions.add(injectionKey);
            const block = await buildContextBlock(sessionInfo.projectPath, row.chat_id, this.ctx.sql)
              .catch((err) => { channelLogger.warn({ err, sid }, "context-inject: query failed"); return null; });
            if (block) {
              contextPrefix = block.content + "\n\n";
              channelLogger.info({ sessionId: sid, projectPath: sessionInfo.projectPath, chatId: row.chat_id, tier: block.tier, messageCount: block.messageCount }, "context-inject: injected");
            } else {
              channelLogger.info({ sessionId: sid, projectPath: sessionInfo.projectPath }, "context-inject: skip (no prior history)");
            }
          }

          const enrichedContent = `${contextPrefix}${ttsNote}${hint}${row.content}`;
          if (hint) channelLogger.debug({ hint: hint.trim() }, "skill hint injected");

          // ⚡ — message taken into work by Claude Code (replaces 👀)
          const token = this.ctx.token?.();
          const telegramMsgId = row.message_id ? Number(row.message_id) : null;
          if (token && telegramMsgId && !isNaN(telegramMsgId)) {
            setTelegramReaction(token, row.chat_id, telegramMsgId, "⚡").catch(() => {});
          }
          // Track which Telegram message is being processed — reply tool uses this to set ✅
          this.ctx.setIncomingTgMsgId?.(row.chat_id, telegramMsgId);
          this.touchIdleTimer();

          // 1. Create status message FIRST so it always appears before Claude's reply.
          // deleteStatusMessage is capped at 4s; sendStatusMessage at 4s: Telegram HTTP retries
          // (up to 60s total) can block the poller loop and cause a deadlock.
          // For burst batches: skip delete for 2nd+ rows of the same chat — sendStatusMessage
          // will update the existing status in-place instead of flashing a 3ms status.
          if (!processedChats.has(row.chat_id)) {
            await withDeadline(this.status.deleteStatusMessage(row.chat_id), 4_000, "deleteStatusMessage");
          }
          processedChats.add(row.chat_id);
          this.status.startTypingForChat(row.chat_id);
          const stage = carriedOverChats.has(row.chat_id)
            ? "➕ Догнал ещё один вопрос"
            : "Thinking...";
          await withDeadline(this.status.sendStatusMessage(row.chat_id, stage, telegramMsgId ?? undefined), 4_000, "sendStatusMessage");

          // 2. Deliver to Claude — status is guaranteed to exist before Claude can reply.
          // Capped at 5s: the SDK's internal stdout drain-wait can hang indefinitely
          // if Claude's stdin pipe is saturated or its process is dead.
          const notificationPromise = this.ctx.mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: enrichedContent,
              meta: {
                chat_id: row.chat_id,
                user: row.from_user,
                message_id: row.message_id || undefined,
                ts: new Date(row.created_at).toISOString(),
                attachments: row.attachments ?? undefined,
              },
            },
          });

          withDeadline(notificationPromise, 5_000, "mcp.notification")
            .then((result) => {
              if (result === DEADLINE_EXCEEDED) {
                // Deadline fired — notification may not have reached Claude
                // Reset delivered=false so the stuck-queue detector can catch it
                channelLogger.warn({ msgId: row.id, chatId: row.chat_id }, "mcp.notification deadline exceeded — resetting delivered=false");
                this.ctx.sql`UPDATE message_queue SET delivered = false WHERE id = ${row.id}`.catch(() => {});
              }
            })
            .catch((err) => channelLogger.warn({ err }, "mcp.notification failed"));
          channelLogger.info({ phase: "poller", step: "notification-sent", msgId: row.id, chatId: row.chat_id, elapsedMs: Date.now() - tDequeue, totalFromQueueMs: Date.now() - new Date(row.created_at).getTime() }, "perf");

          // 3. Start progress monitor — status is now registered, updates will land
          this.status.startProgressMonitorForChat(row.chat_id).catch(() => {});
          this.status.armResponseGuard(row.chat_id);
        }
      } catch (err) {
        channelLogger.error({ err }, "poll error");
      }

      await this.waitForWakeOrTimeout();
    }
  }
}

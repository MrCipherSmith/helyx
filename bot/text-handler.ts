import type { Context } from "grammy";
import { composePrompt } from "../claude/prompt.ts";
import { addMessage } from "../memory/short-term.ts";
import { streamToTelegram } from "./streaming.ts";
import { routeMessage } from "../sessions/router.ts";
import { logger } from "../logger.ts";
import { touchIdleTimer, checkOverflow } from "../memory/summarizer.ts";
import { sql } from "../memory/db.ts";
import { appendLog } from "../utils/stats.ts";
import { pendingInput, clearPendingInput, pendingToolInput, clearPendingTool, pendingScope, getBotRef } from "./handlers.ts";
import { getSwitchContext, clearSwitchContext } from "./switch-cache.ts";
import { replyInThread, escapeHtml } from "./format.ts";
import { recordTypedAnswer } from "../services/ask-question.ts";
import { answerToast } from "../utils/ask-question.ts";
import { sendTelegramMessage, editTelegramMessage } from "../channel/telegram.ts";
import { CONFIG } from "../config.ts";
import { getForumChatId } from "./forum-cache.ts";
import { enqueueForTopic, topicQueueKey } from "./topic-queue.ts";
import { maybeAttachVoice } from "../utils/tts.ts";
export { replyInThread } from "./format.ts";

export async function enqueueToolCommand(
  chatId: string,
  fromUser: string,
  command: string,
  ctx?: Context,
): Promise<void> {
  const route = await routeMessage(chatId);

  if (route.mode !== "cli") {
    if (ctx) await replyInThread(ctx, "⚠️ No active CLI session. Use /switch to connect one.");
    return;
  }

  await sql`
    INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
    VALUES (${route.sessionId}, ${chatId}, ${fromUser}, ${command}, ${"tool"})
  `;

  appendLog(route.sessionId, chatId, "tools", `queued: ${command.slice(0, 80)}`);
  if (ctx) await replyInThread(ctx, `✅ Sent to session: <code>${command}</code>`, { parse_mode: "HTML" });
}

export async function handleText(ctx: Context): Promise<void> {
  const bot = getBotRef();
  const chatId = String(ctx.chat!.id);
  const text = ctx.message?.text;
  if (!text) return;

  // Check for pending input (e.g. waiting for session ID after /switch)
  const scope = pendingScope(ctx);
  const handler = pendingInput.get(scope);
  if (handler) {
    clearPendingInput(ctx);
    await handler(ctx);
    return;
  }

  // Check for pending tool invocation (waiting for arguments)
  const pendingTool = pendingToolInput.get(scope);
  if (pendingTool) {
    clearPendingTool(ctx);
    const command = `/${pendingTool.name} ${text}`.trim();
    await enqueueToolCommand(chatId, ctx.from?.username ?? ctx.from?.first_name ?? "user", command, ctx);
    return;
  }

  // Forum routing
  const forumTopicId = ctx.message?.message_thread_id;
  const forumChatId = await getForumChatId();
  const isForumMessage = forumChatId !== null && chatId === forumChatId;

  // General topic (threadId=1 or no thread) in forum mode → control channel only.
  // Commands still work (handled before this point by grammY command handlers).
  if (isForumMessage && (!forumTopicId || forumTopicId === 1)) {
    await replyInThread(ctx, "💡 General — только команды.\nОткрой топик проекта чтобы работать с сессией.");
    return;
  }

  // An answer the operator was asked to type.
  //
  // Checked before routing, because this message is not a new instruction: a
  // question is waiting for exactly these words, and forwarding them to Claude
  // as an ordinary message would leave the question waiting behind its own
  // answer until it timed out.
  //
  // Placed after the forum resolution rather than before it, because the scope
  // is the point: every topic shares one chat id, and without the project a
  // message typed in one topic could answer a question waiting in another.
  const answeringProject = isForumMessage && forumTopicId
    ? await sql`SELECT path FROM projects WHERE forum_topic_id = ${forumTopicId}`
        .then((rows) => (rows[0]?.path as string | undefined) ?? null)
        .catch(() => null)
    : null;

  const typed = await recordTypedAnswer(
    {
      sql,
      sendMessage: async (chat, body, extra) => {
        const res = await sendTelegramMessage(CONFIG.TELEGRAM_BOT_TOKEN, chat, body, extra);
        return { ok: res.ok, messageId: res.messageId };
      },
      editMessage: async (chat, messageId, body, extra) =>
        editTelegramMessage(CONFIG.TELEGRAM_BOT_TOKEN, chat, messageId, body, { parse_mode: "HTML", ...extra }),
    },
    chatId,
    text,
    answeringProject,
  ).catch((err) => {
    logger.error({ err, chatId }, "typed answer failed");
    return null;
  });

  if (typed) {
    await replyInThread(ctx, answerToast(typed));
    // Only a refusal lets the message through as ordinary text: the question
    // is still waiting, and swallowing it would lose both the answer and the
    // message.
    if (typed.status !== "out-of-range") return;
  }

  // Fire typing indicator immediately — user sees feedback before routeMessage DB query
  ctx.replyWithChatAction("typing", forumTopicId ? { message_thread_id: forumTopicId } : undefined).catch(() => {});

  const t0 = Date.now();
  logger.debug({ phase: "text-handler", step: "typing-sent", chatId, msgId: ctx.message?.message_id, t: t0 }, "perf");

  const route = await routeMessage(chatId, isForumMessage ? forumTopicId : undefined);
  logger.debug({ phase: "text-handler", step: "route-done", chatId, mode: route.mode, elapsedMs: Date.now() - t0 }, "perf");

  appendLog(route.sessionId, chatId, "route", `mode=${route.mode}, session=#${route.sessionId}`);

  if (route.mode === "disconnected") {
    const sessionLabel = escapeHtml(route.sessionName ?? `#${route.sessionId}`);
    const projectHint = route.projectPath ? `\n📁 <code>${escapeHtml(route.projectPath)}</code>` : "";

    // If we have a session_id, queue the message for deferred delivery instead of dropping it.
    // The session subprocess reuses its session_id on restart (resolve() picks up the same row),
    // so the poller will deliver this message automatically when the session comes back.
    // The supervisor stuck-queue alert fires after 5 min if the session never restarts.
    if (route.sessionId) {
      const fromUser = ctx.from?.username ?? ctx.from?.first_name ?? "user";
      const messageId = String(ctx.message?.message_id ?? "");
      await sql`
        INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
        VALUES (${route.sessionId}, ${chatId}, ${fromUser}, ${text}, ${messageId})
        ON CONFLICT (chat_id, message_id)
          WHERE message_id IS NOT NULL AND message_id != '' AND message_id != 'tool'
        DO NOTHING
      `;
      appendLog(route.sessionId, chatId, "route", `session disconnected — queued, will deliver on restart`, "warn");
      await replyInThread(
        ctx,
        `⏳ Сессия <b>${sessionLabel}</b> перезапускается.${projectHint}\nСообщение поставлено в очередь — доставлю автоматически, когда сессия поднимется.`,
        { parse_mode: "HTML" },
      );
      if (ctx.message?.message_id) {
        ctx.react("👀").catch(() => {});
      }
      return;
    }

    // No session_id (0) — either no project is mapped to this forum topic, or session deleted.
    appendLog(0, chatId, "route", `no session for topic — not queued`, "warn");
    const noSessionMsg = route.sessionName
      ? `⚠️ Сессия <b>${sessionLabel}</b> не активна.${projectHint}\n\n` +
        `Если Claude Code запущен — сессия подключится автоматически.\n` +
        `/standalone — standalone режим | /sessions — все сессии`
      : `⚠️ Топик не привязан ни к одному проекту.\nИспользуй /project_add чтобы зарегистрировать проект для этого топика.`;
    await replyInThread(ctx, noSessionMsg, { parse_mode: "HTML" });
    return;
  }

  if (route.mode === "cli") {
    appendLog(route.sessionId, chatId, "route", `cli session #${route.sessionId}`);

    // Save message to short-term memory
    const t1 = Date.now();
    await addMessage({
      sessionId: route.sessionId,
      projectPath: route.projectPath,
      chatId,
      role: "user",
      content: text,
      metadata: {
        messageId: ctx.message?.message_id,
        from: ctx.from?.username ?? ctx.from?.first_name,
      },
    });

    const fromUser = ctx.from?.username ?? ctx.from?.first_name ?? "user";
    const messageId = String(ctx.message?.message_id ?? "");

    logger.debug({ phase: "text-handler", step: "addmsg-done", chatId, sessionId: route.sessionId, elapsedMs: Date.now() - t1 }, "perf");

    // ClaudeAdapter: insert into message_queue — channel.ts handles delivery.
    // ON CONFLICT DO NOTHING: if the bot restarts mid-poll, grammY re-delivers the same
    // Telegram update; the dedup index on (chat_id, message_id) prevents double-queueing.
    const t2 = Date.now();
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${route.sessionId},
        ${chatId},
        ${fromUser},
        ${text},
        ${messageId}
      )
      ON CONFLICT (chat_id, message_id)
        WHERE message_id IS NOT NULL AND message_id != '' AND message_id != 'tool'
      DO NOTHING
    `;
    logger.debug({ phase: "text-handler", step: "queue-inserted", chatId, sessionId: route.sessionId, msgId: messageId, elapsedMs: Date.now() - t2, totalMs: Date.now() - t0 }, "perf");
    appendLog(route.sessionId, chatId, "queue", "message queued for CLI");

    // 👀 — received by bot, waiting for Claude Code to pick it up
    if (ctx.message?.message_id) {
      ctx.api.setMessageReaction(ctx.chat!.id, ctx.message.message_id, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
    }

    touchIdleTimer(route.sessionId, chatId, route.projectPath);
    return;
  }

  // Standalone mode: enqueue per-topic so different topics run in parallel
  // but messages within the same topic stay sequential.
  const sessionId = route.sessionId;
  const projectPath = route.projectPath;
  const queueKey = topicQueueKey(chatId, isForumMessage ? forumTopicId : null);

  enqueueForTopic(
    queueKey,
    async () => {
      await ctx.replyWithChatAction("typing");

      // 👀 — received and processing started (standalone mode)
      if (ctx.message?.message_id) {
        ctx.api.setMessageReaction(ctx.chat!.id, ctx.message.message_id, [{ type: "emoji", emoji: "👀" }]).catch(() => {});
      }

      appendLog(sessionId, chatId, "receive", `user message: ${text.slice(0, 80)}`);

      await addMessage({
        sessionId,
        projectPath,
        chatId,
        role: "user",
        content: text,
        metadata: {
          messageId: ctx.message?.message_id,
          from: ctx.from?.username ?? ctx.from?.first_name,
        },
      });

      const switchCtx = getSwitchContext(chatId);
      let effectiveText = text;
      if (switchCtx) {
        effectiveText = `[Project context from prior session]\n${switchCtx.summary}\n\n[User message]\n${text}`;
        clearSwitchContext(chatId);
      }

      const { system, messages } = await composePrompt(sessionId, chatId, effectiveText);

      try {
        appendLog(sessionId, chatId, "llm", "streaming response...");
        const response = await streamToTelegram(bot, ctx.chat!.id, system, messages, { sessionId, chatId, operation: "chat" }, forumTopicId);
        appendLog(sessionId, chatId, "reply", `sent ${response.length} chars`);
        await addMessage({ sessionId, projectPath, chatId, role: "assistant", content: response });
        maybeAttachVoice(bot, ctx.chat!.id, response, isForumMessage ? forumTopicId : null);
      } catch (err: any) {
        appendLog(sessionId, chatId, "llm", `error: ${err?.message ?? err}`, "error");
        await replyInThread(ctx, `Error: ${err?.message ?? "unknown error"}`);
      }

      touchIdleTimer(sessionId, chatId, projectPath);
      await checkOverflow(sessionId, chatId, projectPath);
    },
    (position) => {
      replyInThread(ctx, `⏳ В очереди (#${position}). Предыдущий запрос обрабатывается...`)
        .catch(() => {});
    },
  );
}

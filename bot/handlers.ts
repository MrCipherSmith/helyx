import type { Bot, Context } from "grammy";

// === Shared state ===

/**
 * The conversation a pending step belongs to.
 *
 * Every topic in a forum shares one chat id, so keying a step by chat alone let
 * a prompt opened in one topic swallow the next message typed in another: an
 * add-flow left waiting in one topic ate ordinary chat somewhere else entirely,
 * and that text reached the provider list instead of the session.
 *
 * A forum topic is separated by its thread id. A plain group also carries
 * `message_thread_id` on replies, but there it only marks a reply chain — which
 * the operator is under no obligation to answer inside — so the chat has to be
 * a forum before the thread narrows anything.
 *
 * `chat.is_forum` rather than `message.is_topic_message`: the prompt and the
 * answer to it have to land on the same key, and the two messages are not
 * guaranteed to be flagged alike. The chat's own nature is the same for both.
 * A forum's General topic carries no thread id and scopes to the chat, again
 * from either side.
 */
export function pendingScope(ctx: Context): string {
  const chatId = String(ctx.chat?.id ?? "");
  const threadId = ctx.chat?.is_forum ? ctx.msg?.message_thread_id : undefined;
  return threadId ? `${chatId}:${threadId}` : chatId;
}

// Pending input: scope -> handler that processes the next text message
export const pendingInput = new Map<string, (ctx: Context) => Promise<void>>();
const pendingInputTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Pending tool invocation: waiting for user to supply arguments
export interface PendingTool {
  type: "skill" | "cmd";
  name: string;
}
export const pendingToolInput = new Map<string, PendingTool>();
const pendingToolTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setPendingTool(ctx: Context, tool: PendingTool): void {
  const scope = pendingScope(ctx);
  const existing = pendingToolTimers.get(scope);
  if (existing) clearTimeout(existing);
  pendingToolInput.set(scope, tool);
  pendingToolTimers.set(scope, setTimeout(() => {
    pendingToolInput.delete(scope);
    pendingToolTimers.delete(scope);
  }, 5 * 60_000)); // 5 min TTL
}

export function clearPendingTool(ctx: Context): void {
  const scope = pendingScope(ctx);
  pendingToolInput.delete(scope);
  const t = pendingToolTimers.get(scope);
  if (t) { clearTimeout(t); pendingToolTimers.delete(scope); }
}

export function setPendingInput(
  ctx: Context,
  handler: (ctx: Context) => Promise<void>,
  ttlMs = 60_000,
): void {
  const scope = pendingScope(ctx);
  const existing = pendingInputTimers.get(scope);
  if (existing) clearTimeout(existing);

  pendingInput.set(scope, handler);
  pendingInputTimers.set(scope, setTimeout(() => {
    pendingInput.delete(scope);
    pendingInputTimers.delete(scope);
  }, ttlMs));
}

export function clearPendingInput(ctx: Context): void {
  const scope = pendingScope(ctx);
  pendingInput.delete(scope);
  const timer = pendingInputTimers.get(scope);
  if (timer) { clearTimeout(timer); pendingInputTimers.delete(scope); }
}

// Bot reference set from bot.ts
let bot: Bot | null = null;
export function setBotRef(b: Bot): void {
  bot = b;
}
export function getBotRef(): Bot {
  if (!bot) throw new Error("Bot reference not set — call setBotRef() first");
  return bot;
}

// === Handler imports ===

import { handleSessions, handleSwitch, handleSwitchTo, handleSessionInfo, handleRename, handleRemove, handleCleanup, handleStart, handleHelp } from "./commands/session.ts";
import { handleRemember, handleRecall, handleMemories, handleForget, handleSummarize, handleClear } from "./commands/memory.ts";
import { handleStats, handleLogs, handleStatus, handlePending, handleTools, handleSkills, handleCommands, handleHooks, handleRules, handlePermissionStats, handleSessionExport } from "./commands/admin.ts";
import { handleAdd } from "./commands/add.ts";
import { handleModel } from "./commands/model.ts";
import { handleRemoteControl } from "./commands/remote-control.ts";
import { handleInterrupt } from "./commands/interrupt.ts";
import { handleBtw } from "./commands/btw.ts";
import { handleMonitor } from "./commands/monitor.ts";
import { handleProjects } from "./commands/projects.ts";
import { handleProjectAdd } from "./commands/project-add.ts";
import { handleProjectFacts, handleProjectScan } from "./commands/project-facts.ts";
import { handleMemoryExport, handleMemoryImport } from "./commands/memory-export.ts";
import { handleForumSetup, handleForumSync, handleForumClean, handleTopicRename, handleTopicClose, handleTopicReopen, handleForumHub } from "./commands/forum.ts";
import { handleQuickstart } from "./commands/quickstart.ts";
import { handleSystem } from "./commands/system.ts";
import { handleMenu } from "./commands/menu.ts";
import { handleResume } from "./commands/resume.ts";
import { handleCodexSetup, handleCodexStatus, handleCodexReview } from "./commands/codex.ts";
import {
  handleReviewers,
  handleReviewersAdd,
  handleReviewersDefault,
  handleReviewersRemove,
  handleReviewersStatus,
} from "./commands/reviewers.ts";
import { handleVoice, handlePhoto, handleDocument, handleVideo, handleVideoNote, handleSticker } from "./media.ts";
import { handleCallbackQuery } from "./callbacks.ts";
import { handleText } from "./text-handler.ts";
import { handlePollAnswer } from "./poll-handler.ts";
import { replyInThread } from "./format.ts";

// === Register all handlers ===

/**
 * Whether grammY will hand this text to a command handler.
 *
 * Deliberately narrower than "starts with a slash": /project_add prompts for an
 * absolute path, and `/home/altsay/thing` has to reach the step that asked for
 * it rather than read as a command and cancel it. grammY only matches a bare
 * `/name` or `/name@bot` closed by whitespace or end of text, so that is the
 * line drawn here — anything it would not route as a command falls through to
 * the waiting step, exactly as before.
 */
const BARE_COMMAND = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?(\s|$)/;

export function looksLikeCommand(text: string): boolean {
  return BARE_COMMAND.test(text);
}

export function registerHandlers(b: Bot): void {
  // A command abandons whatever prompt is open, so retire the prompt here —
  // before any command handler runs.
  //
  // grammY matches commands ahead of the text handler and a command handler
  // does not call next(), so the step that was waiting never saw the message
  // and never got to clear itself. It stayed armed for the rest of its TTL and
  // then swallowed the operator's next ordinary message: typing /projects in
  // the middle of adding a provider silently dropped the add-flow, and the
  // message after that went to the abandoned flow instead of the session.
  b.on("message:text", async (ctx, next) => {
    if (!looksLikeCommand(ctx.message?.text ?? "")) return next();

    const scope = pendingScope(ctx);
    const abandoned = pendingInput.has(scope) || pendingToolInput.has(scope);
    clearPendingInput(ctx);
    clearPendingTool(ctx);
    if (abandoned) {
      await replyInThread(ctx, "↩️ Dropped the step that was waiting — running the command instead.")
        .catch(() => {});
    }
    return next();
  });

  // Session commands
  b.command("sessions", handleSessions);
  b.command("switch", handleSwitch);
  b.command("standalone", (ctx) => handleSwitchTo(ctx, 0));
  b.command("session", handleSessionInfo);
  b.command("rename", handleRename);
  b.command("start", handleStart);
  b.command("help", handleHelp);
  b.command("quickstart", handleQuickstart);

  // Memory commands
  b.command("remember", handleRemember);
  b.command("recall", handleRecall);
  b.command("memories", handleMemories);
  b.command("forget", handleForget);
  b.command("memory_export", handleMemoryExport);
  b.command("memory_import", handleMemoryImport);
  // Import via document with /memory_import caption (must call next() for other docs to pass through)
  b.on("message:document", async (ctx, next) => {
    const caption = ctx.message.caption ?? "";
    if (caption.startsWith("/memory_import")) await handleMemoryImport(ctx);
    else await next();
  });

  // Utility commands
  b.command("clear", handleClear);
  b.command("remove", handleRemove);
  b.command("cleanup", handleCleanup);
  b.command("summarize", handleSummarize);
  b.command("resume", handleResume);
  b.command("status", handleStatus);
  b.command("stats", handleStats);
  b.command("logs", handleLogs);
  b.command("pending", handlePending);
  b.command("permission_stats", handlePermissionStats);
  b.command("session_export", handleSessionExport);
  b.command("tools", handleTools);
  b.command("skills", handleSkills);
  b.command("commands", handleCommands);
  b.command("hooks", handleHooks);
  b.command("rules", handleRules);

  // Session CLI commands
  b.command("add", handleAdd);
  b.command("model", handleModel);

  // Codex
  b.command("codex_setup", handleCodexSetup);
  b.command("codex_status", handleCodexStatus);
  b.command("codex_review", handleCodexReview);

  // Independent reviewers (parallel pipeline)
  b.command("reviewers", handleReviewers);
  b.command("reviewers_status", handleReviewersStatus);
  b.command("reviewers_add", handleReviewersAdd);
  b.command("reviewers_remove", handleReviewersRemove);
  b.command("reviewers_default", handleReviewersDefault);

  // System control
  b.command("system", handleSystem);
  b.command("menu", handleMenu);
  b.command("supervisor", async (ctx) => {
    const { handleSupervisorCommand } = await import("./commands/supervisor-actions.ts");
    return handleSupervisorCommand(ctx);
  });

  // Remote control & project management
  b.command("interrupt", handleInterrupt);
  b.command("btw", handleBtw);
  b.command("remote_control", handleRemoteControl);
  b.command("monitor", handleMonitor);
  b.command("projects", handleProjects);
  b.command("providers", async (ctx) => {
    const { handleProviders } = await import("./commands/providers.ts");
    await handleProviders(ctx);
  });
  b.command("project_add", handleProjectAdd);
  b.command("project_facts", handleProjectFacts);
  b.command("project_scan", handleProjectScan);

  // Forum topic management
  b.command("forum_setup", handleForumSetup);
  b.command("forum_sync", handleForumSync);
  b.command("forum_clean", handleForumClean);
  b.command("forum_hub", handleForumHub);
  b.command("topic_rename", handleTopicRename);
  b.command("topic_close", handleTopicClose);
  b.command("topic_reopen", handleTopicReopen);

  // Inline keyboard callbacks (permissions, session switch).
  // Wrapped rather than passed directly: the handler takes an injectable
  // handler map as an optional second parameter, and grammy would hand it its
  // own `next` there.
  b.on("callback_query:data", (ctx) => handleCallbackQuery(ctx));

  // Media handlers
  b.on("message:photo", handlePhoto);
  b.on("message:document", handleDocument);
  b.on("message:voice", handleVoice);
  b.on("message:video", handleVideo);
  b.on("message:video_note", handleVideoNote);
  b.on("message:sticker", handleSticker);

  // Poll answers (non-anonymous polls)
  b.on("poll_answer", handlePollAnswer);

  // Supervisor topic — intercept text before sending to Claude
  b.on("message:text", async (ctx, next) => {
    const threadId = ctx.message?.message_thread_id;
    const supervisorTopicId = Number(process.env.SUPERVISOR_TOPIC_ID ?? "0");
    if (supervisorTopicId > 0 && threadId === supervisorTopicId) {
      const { handleSupervisorMessage } = await import("./commands/supervisor-actions.ts");
      return handleSupervisorMessage(ctx);
    }
    return next();
  });

  // Text messages → Claude (must be last)
  b.on("message:text", handleText);
}

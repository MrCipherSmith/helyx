import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { CONFIG } from "../config.ts";
import { accessMiddleware } from "./access.ts";
import { registerHandlers, setBotRef } from "./handlers.ts";
import { logger } from "../logger.ts";

/**
 * Simple per-chat rate limiter transformer.
 * Queues API calls per chat_id to stay within Telegram's ~20 msg/min per group limit.
 * Allows 1 call per MIN_INTERVAL_MS per chat; non-chat calls are pass-through.
 */
function createChatThrottler(minIntervalMs = 500) {
  const lastCall = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();

  return async (prev: any, method: string, payload: any, signal: AbortSignal) => {
    const chatId = payload?.chat_id != null ? String(payload.chat_id) : null;
    if (!chatId) return prev(method, payload, signal);

    const enqueue = (fn: () => Promise<unknown>) => {
      const tail = queues.get(chatId) ?? Promise.resolve();
      const next = tail.then(fn).catch(() => {});
      queues.set(chatId, next);
      next.finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
      return next;
    };

    return new Promise((resolve, reject) => {
      enqueue(async () => {
        const now = Date.now();
        const last = lastCall.get(chatId) ?? 0;
        const wait = minIntervalMs - (now - last);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCall.set(chatId, Date.now());
        try {
          resolve(await prev(method, payload, signal));
        } catch (err) {
          reject(err);
        }
      });
    });
  };
}

export function createBot(): Bot {
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

  // Per-chat throttler: max 2 API calls/sec per chat (well within Telegram's ~20/min limit)
  bot.api.config.use(createChatThrottler(500));

  // Auto-retry on 429 Too Many Requests — waits retry_after and retries automatically
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, rethrowInternalServerErrors: false }));

  // Access control middleware
  bot.use(accessMiddleware);

  // Register all handlers
  setBotRef(bot);
  registerHandlers(bot);

  // Set bot commands menu in Telegram
  // Sorted by frequency of use: most common first
  bot.api.setMyCommands([
    // Daily use
    { command: "sessions", description: "List sessions" },
    { command: "switch", description: "Switch session (with context)" },
    { command: "session", description: "Current session" },
    { command: "standalone", description: "Standalone mode" },
    { command: "pending", description: "Pending CLI permissions" },
    { command: "permission_stats", description: "Permission history analytics" },
    // Memory
    { command: "remember", description: "Save to memory" },
    { command: "recall", description: "Search memory" },
    { command: "memories", description: "List memories" },
    { command: "forget", description: "Delete memory" },
    { command: "memory_export", description: "Export memories as JSON" },
    { command: "memory_import", description: "Import memories from JSON file" },
    // Monitoring
    { command: "stats", description: "API stats, tokens, transcriptions" },
    { command: "logs", description: "Session logs" },
    { command: "status", description: "Bot health (DB, Ollama)" },
    { command: "session_export", description: "Export session as markdown transcript" },
    // Knowledge base
    { command: "skills", description: "Skills from goodai-base" },
    { command: "rules", description: "Rules from goodai-base" },
    { command: "tools", description: "MCP tools" },
    // Remote control
    { command: "remote_control", description: "tmux bots status (Kill/Start)" },
    { command: "projects", description: "List projects (Start/Stop)" },
    { command: "project_add", description: "Add project to config" },
    { command: "project_facts", description: "Show project knowledge facts" },
    { command: "project_scan", description: "Scan project for knowledge (rescan)" },
    // Forum management
    { command: "forum_setup", description: "Configure forum supergroup (run in group)" },
    { command: "forum_sync", description: "Sync forum topics for all projects" },
    { command: "forum_hub", description: "Pin Dev Hub WebApp button in General topic" },
    { command: "topic_rename", description: "Rename current project topic" },
    { command: "topic_close", description: "Close current project topic" },
    { command: "topic_reopen", description: "Reopen current project topic" },
    // Maintenance
    { command: "clear", description: "Clear context" },
    { command: "summarize", description: "Summarize conversation" },
    { command: "rename", description: "Rename session" },
    { command: "cleanup", description: "Clean up inactive sessions" },
    // Help
    { command: "help", description: "Help" },
  ]).catch((err) => logger.error({ err }, "failed to set bot commands"));

  // Set WebApp menu button (requires HTTPS URL for production)
  const webAppUrl = CONFIG.TELEGRAM_WEBHOOK_URL
    ? new URL(CONFIG.TELEGRAM_WEBHOOK_URL).origin + "/webapp/"
    : "";
  if (CONFIG.TELEGRAM_WEBHOOK_URL) {
    bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Dev Hub", web_app: { url: webAppUrl } } })
      .catch((err) => logger.error({ err }, "failed to set menu button"));
  }

  // Error handler
  bot.catch((err) => {
    logger.error({ err }, "bot error");
  });

  return bot;
}

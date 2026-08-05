import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { CONFIG } from "../config.ts";
import { accessMiddleware } from "./access.ts";
import { registerHandlers, setBotRef } from "./handlers.ts";
import { logger } from "../logger.ts";

export function createBot(): Bot {
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);

  // Auto-retry on 429 Too Many Requests — waits retry_after and retries automatically
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, rethrowInternalServerErrors: false }));

  // Access control middleware
  bot.use(accessMiddleware);

  // Register all handlers
  setBotRef(bot);
  registerHandlers(bot);


  // Set WebApp menu button (requires HTTPS URL for production).
  //
  // And requires the Mini App to exist. It used to be set on the webhook URL
  // alone, knowing nothing about whether anything had been built — so a bot
  // built with WITH_DASHBOARD=false offered a button that opened `Not Found`.
  // A button that cannot keep its promise is worse than no button: the operator
  // presses it more than once.
  const webAppUrl = CONFIG.TELEGRAM_WEBHOOK_URL
    ? new URL(CONFIG.TELEGRAM_WEBHOOK_URL).origin + "/webapp/"
    : "";
  if (CONFIG.TELEGRAM_WEBHOOK_URL) {
    void (async () => {
      const { dashboardFacts } = await import("../mcp/dashboard-api.ts");
      const { shouldOfferMiniApp } = await import("../utils/dashboard-readiness.ts");
      if (!shouldOfferMiniApp(await dashboardFacts())) {
        logger.warn("mini app not built — menu button not set");
        return;
      }
      await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Dev Hub", web_app: { url: webAppUrl } } })
        .catch((err) => logger.error({ err }, "failed to set menu button"));
    })();
  }

  // Error handler
  bot.catch((err) => {
    logger.error({ err }, "bot error");
  });

  return bot;
}

import { CONFIG } from "./config.ts";
import { migrate, sql } from "./memory/db.ts";
import { createBot } from "./bot/bot.ts";
import { startMcpHttpServer } from "./mcp/server.ts";
import { stopAllTimers } from "./memory/summarizer.ts";

function startCleanupTimer() {
  const INTERVAL = 60 * 60 * 1000; // 1 hour

  const cleanup = async () => {
    try {
      const mq = await sql`DELETE FROM message_queue WHERE delivered = true AND created_at < now() - interval '24 hours'`;
      const logs = await sql`DELETE FROM request_logs WHERE created_at < now() - interval '7 days'`;
      const stats = await sql`DELETE FROM api_request_stats WHERE created_at < now() - interval '30 days'`;
      const perms = await sql`DELETE FROM permission_requests WHERE created_at < now() - interval '1 hour'`;
      const total = mq.count + logs.count + stats.count + perms.count;
      if (total > 0) {
        console.log(`[cleanup] deleted: queue=${mq.count} logs=${logs.count} stats=${stats.count} perms=${perms.count}`);
      }
    } catch (err) {
      console.error("[cleanup] error:", err);
    }
  };

  cleanup(); // run once at startup
  return setInterval(cleanup, INTERVAL);
}

async function main() {
  console.log("[main] starting claude-bot...");

  // 1. Database migrations
  await migrate();

  // 2. Create Telegram bot
  const bot = createBot();

  // 3. Start MCP HTTP server
  const httpServer = startMcpHttpServer(bot);

  // 4. Start cleanup timer
  const cleanupTimer = startCleanupTimer();

  // 5. Start Telegram polling
  console.log("[main] starting Telegram polling...");
  bot.start({
    onStart: () => console.log(`[main] bot @${bot.botInfo.username} is running`),
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[main] shutting down...");
    clearInterval(cleanupTimer);
    stopAllTimers();
    httpServer.close();
    await bot.stop();
    await sql.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});

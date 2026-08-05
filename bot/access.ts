import type { Context, NextFunction } from "grammy";
import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";

export async function accessMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  // poll_answer updates don't populate ctx.from — use pollAnswer.user as fallback
  const userId = ctx.from?.id ?? ctx.pollAnswer?.user?.id;

  if (!userId) return;

  // If explicitly opened to all users
  if (CONFIG.ALLOW_ALL_USERS) {
    return next();
  }

  if (CONFIG.ALLOWED_USERS.includes(userId)) {
    return next();
  }

  // Our own id is not an intruder.
  //
  // The bot reacts to every message it queues, and Telegram reports that back
  // as an update whose actor is the bot. It is not in ALLOWED_USERS — nothing
  // would work if it were — so it fell through to the warning below and put an
  // "access denied" line in the log after every single message the operator
  // sent. Dropped the same way, without the alarm.
  if (ctx.me && userId === ctx.me.id) return;

  // Silently drop unauthorized messages
  logger.warn({ userId }, "access denied");
}

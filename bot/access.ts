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

/**
 * Is this update from the configured admin (`CONFIG.SUPERVISOR_CHAT_ID`)?
 *
 * Fails closed: an unset `SUPERVISOR_CHAT_ID` denies everyone, rather than
 * (as a naive `adminChatId && …` short-circuit would) granting everyone.
 * `SUPERVISOR_CHAT_ID` defaults to `""` and is documented as a supported
 * "notifications disabled" state (config.ts), so this is not a hypothetical.
 *
 * Checks both `chat.id` and `from.id`: in DMs they're the same value, but in
 * forum topics `chat.id` is the group's id while `from.id` is the admin's own
 * personal id — only the latter matches `SUPERVISOR_CHAT_ID` there.
 *
 * Single source of truth for this check. Previously reimplemented
 * independently in six places (bot/commands/{system,restart-grant,menu,
 * monitor,supervisor-actions,prepare-restart}.ts); two of those copies
 * (monitor.ts, supervisor-actions.ts) had silently drifted into a fail-open
 * `adminChatId && chat.id !== adminChatId` shape, and two more (monitor.ts,
 * supervisor-actions.ts again) were missing the `from.id` fallback — see
 * review findings F-001/F-001b (security) and F-004 (architecture),
 * 2026-09-01.
 */
export function isAdmin(ctx: Context): boolean {
  const adminChatId = CONFIG.SUPERVISOR_CHAT_ID;
  if (!adminChatId) return false; // fail closed — no config, no access
  return String(ctx.chat?.id) === adminChatId || String(ctx.from?.id) === adminChatId;
}

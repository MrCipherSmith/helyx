/**
 * The first tap of a restart confirmation (A2).
 *
 * Every button that used to enqueue `bounce`, `host_restart` or
 * `full_restart` straight into `admin_commands` now calls this first. It
 * states the fingerprint in words (AC6) and issues an unconsumed operator
 * grant carrying it, then waits for the second tap — `grant:go:<id>`,
 * handled by `bot/commands/restart-grant.ts` — before anything is enqueued.
 *
 * Returns `false` for a command `fingerprintOf` does not gate (everything
 * that never took the restart lease: `docker_restart`, `docker_restart_all`,
 * `stack_up`, `channel_kill`, `tmux_start`, `tmux_stop`, …), so a caller can
 * fall through to its existing immediate-enqueue behaviour unchanged.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../memory/db.ts";
import { fingerprintOf, confirmationText, issueOperatorGrant } from "../utils/action-approval-grant.ts";

export async function beginRestartConfirmation(
  ctx: Context,
  command: string,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const fingerprint = fingerprintOf({ command, payload });
  if (!fingerprint) return false;

  const issuedBy = ctx.from?.id;
  if (!issuedBy) {
    await ctx.answerCallbackQuery({ text: "No user on this request" });
    return true;
  }

  const statedTo = confirmationText(fingerprint);
  const grant = await issueOperatorGrant(sql, {
    fingerprint,
    issuedBy,
    pendingCommand: command,
    pendingPayload: payload,
    statedTo,
  });

  const kb = new InlineKeyboard()
    .text("✅ Подтвердить", `grant:go:${grant.grantId}`)
    .text("❌ Отмена", `grant:cancel:${grant.grantId}`);
  const text = `${statedTo}\n\nПодтвердить?`;

  if (ctx.callbackQuery) {
    // A button (`sys:bounce`, `sup:bounce`, …) — edit the message the operator
    // just tapped, same as the immediate-enqueue path used to.
    await ctx.answerCallbackQuery({ text: "Подтвердите действие" });
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  } else {
    // A slash command (`/restart_host`) — nothing to edit, so this is a new
    // message with the same two buttons.
    await ctx.reply(text, { reply_markup: kb });
  }
  return true;
}

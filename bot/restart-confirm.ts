/**
 * The first tap of a restart confirmation (A2).
 *
 * Every button that used to enqueue `bounce`, `host_restart` or
 * `full_restart` straight into `admin_commands` now calls this first. It
 * states the fingerprint in words (AC6) and issues an unconsumed operator
 * grant carrying it, then waits for the second tap — `grant:go:<id>`,
 * handled by `bot/commands/restart-grant.ts` — before anything is enqueued.
 *
 * Returns `false` for a command `fingerprintOf` does not gate at all
 * (`stack_up`, `tmux_start`, `proj_start`, and everything outside the
 * fingerprint model), so a caller can fall through to its existing
 * immediate-enqueue behaviour unchanged.
 *
 * Returns `true` — telling the caller NOT to fall through — for a command
 * that IS in `GATED_RESTART_COMMANDS` but whose payload `fingerprintOf`
 * cannot derive a fingerprint from (malformed: `docker_restart` with no
 * `container`, `proj_stop` with no `path`). **Corrected 2026-08-12,
 * DeepSeek finding #1**: this used to return `false` for both cases alike,
 * and every caller reads `false` as "not gated, enqueue directly" — so a
 * gated command with a malformed payload reached `admin_commands` with no
 * grant, the exact bypass this module exists to close. Every current caller
 * happens to build a well-formed payload, so this was unreachable in
 * practice; it stops being unreachable the day one doesn't.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../memory/db.ts";
import { fingerprintOf, confirmationText, issueOperatorGrant } from "../utils/action-approval-grant.ts";
import { GATED_RESTART_COMMANDS } from "../scripts/restart-gate.ts";

export async function beginRestartConfirmation(
  ctx: Context,
  command: string,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const fingerprint = fingerprintOf({ command, payload });
  if (!fingerprint) {
    if (!GATED_RESTART_COMMANDS.has(command)) return false;
    // Gated, but malformed — refuse rather than let the caller fall through
    // to an unguarded enqueue.
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Refused — malformed request, nothing to approve" });
    } else {
      await ctx.reply("⛔ Refused — malformed request, nothing to approve");
    }
    return true;
  }

  const issuedBy = ctx.from?.id;
  if (!issuedBy) {
    await ctx.answerCallbackQuery({ text: "No user on this request" });
    return true;
  }

  const statedTo = confirmationText(fingerprint, command);
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

/**
 * `grant:go:<id>` / `grant:cancel:<id>` — the second tap of a restart
 * confirmation (A2).
 *
 * The first tap (`sys:bounce`, `sys:full_restart`, `sys:restart_host`, or
 * `sup:bounce`) issues an operator grant and edits the message to state the
 * fingerprint in words, per P-2.1 and AC6. This handles the tap that answers
 * it. Only the grant id travels in this callback's data — never the command
 * it will enqueue (P-5.4) — so what runs is whatever `pendingCommand` /
 * `pendingPayload` the grant itself was issued with, read back from the
 * database rather than trusted from the button.
 *
 * This does not consume the grant. `scripts/restart-gate.ts` does, at the
 * moment `scripts/admin-daemon.ts` is actually about to run the command —
 * the one place P-2.5 requires the fingerprint to be re-derived and checked.
 * A tap here only decides what gets enqueued.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";
import { getGrant, cancelGrant, extendGrantForExecution } from "../../utils/action-approval-grant.ts";

function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (!adminChatId) return false;
  return String(ctx.chat?.id) === adminChatId || String(ctx.from?.id) === adminChatId;
}

export async function handleRestartGrantCallback(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "Admin only" });
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  const rest = data.slice("grant:".length);
  const sep = rest.indexOf(":");
  const action = sep === -1 ? rest : rest.slice(0, sep);
  const grantId = sep === -1 ? "" : rest.slice(sep + 1);

  if (!grantId) {
    await ctx.answerCallbackQuery({ text: "Invalid grant" });
    return;
  }

  if (action === "cancel") {
    await cancelGrant(sql, grantId);
    await ctx.answerCallbackQuery({ text: "Отменено" });
    await ctx.editMessageText("❌ Отменено.", { reply_markup: new InlineKeyboard() }).catch(() => {});
    return;
  }

  if (action !== "go") {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  const grant = await getGrant(sql, grantId);
  if (!grant || grant.consumedAt || !grant.pendingCommand) {
    await ctx.answerCallbackQuery({ text: "Grant expired or already used" });
    await ctx.editMessageText("⏰ Запрос истёк — подтвердите ещё раз через /system.", {
      reply_markup: new InlineKeyboard(),
    }).catch(() => {});
    return;
  }
  if (grant.expiresAt && Date.now() > new Date(grant.expiresAt).getTime()) {
    await ctx.answerCallbackQuery({ text: "Grant expired" });
    await ctx.editMessageText("⏰ Запрос истёк — подтвердите ещё раз через /system.", {
      reply_markup: new InlineKeyboard(),
    }).catch(() => {});
    return;
  }
  // The grant records who it was issued to for exactly this check — an admin
  // chat is a trust boundary for "may issue restarts", not for "may spend
  // someone else's confirmation". `issuedBy` is a Telegram user id for every
  // operator grant, which is the only kind that ever reaches this handler
  // (`pendingCommand` is null on a standing grant).
  if (typeof grant.issuedBy === "number" && ctx.from?.id !== grant.issuedBy) {
    await ctx.answerCallbackQuery({ text: "This confirmation is not yours to answer" });
    return;
  }

  // F4 — the 3-minute TTL from the first tap only had to survive the operator
  // reading one sentence; from here it has to survive however long this
  // command waits behind whatever is already in the queue. Reset the clock at
  // the tap that actually approved it, not the one that only asked to see it.
  await extendGrantForExecution(sql, grantId);

  // Same duplicate-command guard the direct-enqueue path already had: two taps
  // of the same confirmation, or a button race with a slash command, must not
  // enqueue the same restart twice. Scoped by `project_id` when the pending
  // payload carries one (`proj_stop`) — otherwise stopping one project would
  // block stopping an unrelated one that merely shares the command name.
  // Written as a single atomic INSERT ... WHERE NOT EXISTS rather than a
  // separate SELECT-then-INSERT: two concurrent taps of the same confirmation
  // (a double-tap, a Telegram callback retry) could otherwise both see no
  // existing row and both insert.
  const projectId = grant.pendingPayload && typeof grant.pendingPayload.project_id === "number"
    ? grant.pendingPayload.project_id
    : null;
  const payload = sql.json({ ...grant.pendingPayload, grantId } as any);
  const inserted = projectId !== null
    ? await sql`
        INSERT INTO admin_commands (command, payload)
        SELECT ${grant.pendingCommand}, ${payload}
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_commands
          WHERE command = ${grant.pendingCommand}
            AND status IN ('pending', 'processing')
            AND (payload->>'project_id')::int = ${projectId}
        )
        RETURNING id
      `
    : await sql`
        INSERT INTO admin_commands (command, payload)
        SELECT ${grant.pendingCommand}, ${payload}
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_commands
          WHERE command = ${grant.pendingCommand} AND status IN ('pending', 'processing')
        )
        RETURNING id
      `;
  if (inserted.length === 0) {
    await ctx.answerCallbackQuery({ text: "Already in progress..." });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Запущено" });
  await ctx.editMessageText(`✅ Подтверждено — выполняется.\n\nUse 🔄 Refresh in /system to check status.`, {
    reply_markup: new InlineKeyboard(),
  }).catch(() => {});
}

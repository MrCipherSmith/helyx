/**
 * Telegram callback handlers for per-session tmux actions.
 * Callback data format: tmux:ACTION:PROJECT_NAME
 *
 * Actions:
 *   esc          — send Escape to interrupt Claude, auto-confirm if prompted
 *   close_editor — force-close vim (:q!) or nano (^X n)
 *
 * Queues an admin_command so the host-side admin-daemon executes the
 * tmux send-keys outside the Docker container.
 *
 * ─── Phase-2-aware design note ──────────────────────────────────────────────
 * The proposal (jobs/analysis--agent-runtime-refactor/man/proposal.md, P2-11)
 * lists an option to bypass `admin_commands` and call
 * `RuntimeManager.getDriver("tmux").sendInput(...)` inline. We deliberately
 * keep the queue-based path because this handler runs INSIDE the bot Docker
 * container, whereas `TmuxDriver` requires shell access to the host tmux
 * server (the bot container has no `tmux` binary or socket bind-mount).
 *
 * The right end-state is: bot writes a high-level intent, admin-daemon
 * resolves it through `RuntimeManager` on the host. That pivot lands in
 * Phase 4 alongside `agent_instances` and the reconcile loop. Until then,
 * `admin_commands` IS the runtime-manager bridge — do not migrate yet.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";

export async function handleTmuxActionCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  // tmux:ACTION:project (project name may contain colons — join from index 2)
  const parts   = data.split(":");
  const action  = parts[1];
  const project = parts.slice(2).join(":");

  if (!action || !project) {
    await ctx.answerCallbackQuery({ text: "Invalid action" });
    return;
  }

  const label: Record<string, string> = {
    esc:          "⚡ Interrupt sent",
    close_editor: "📝 Close editor sent",
  };

  if (!(action in label)) {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES ('tmux_send_keys', ${JSON.stringify({ project, action })}::jsonb)
  `;

  await ctx.answerCallbackQuery({ text: label[action] });
  // Remove buttons so the action can't be triggered twice
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
}

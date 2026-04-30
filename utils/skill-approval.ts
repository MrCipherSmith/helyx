// FR-C-10: human-in-the-loop approval for agent-created skills.
//
// Sends a Telegram message with [Save] / [Reject] / [Edit name…] inline
// keyboard. Called from `propose_skill` after a row is inserted as 'proposed'.
// The bot dispatcher (`bot/callbacks.ts`) routes the callback queries:
//   skill:save:<id>     → approveSkill(id) → status='active'
//   skill:reject:<id>   → rejectSkill(id) → status='rejected'
//   skill:editname:<id> → set pending state, wait for next text message

import { sendTelegramMessage } from "../channel/telegram.ts";

const TG_TEXT_MAX = 3500; // Telegram caps at 4096 chars; reserve room for header/buttons.

export interface SkillApprovalParams {
  skillId: number;
  name: string;
  description: string;
  body: string;
  warnings?: string[];
  chatId: string;
  topicId?: number;
}

function buildKeyboard(skillId: number) {
  return {
    inline_keyboard: [
      [
        { text: "💾 Save", callback_data: `skill:save:${skillId}` },
        { text: "❌ Reject", callback_data: `skill:reject:${skillId}` },
      ],
      [
        { text: "✏️ Edit name", callback_data: `skill:editname:${skillId}` },
      ],
    ],
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMessage(params: SkillApprovalParams): string {
  const { name, description, body, warnings = [] } = params;
  const warningBlock = warnings.length > 0
    ? `\n\n⚠️ <b>Warnings:</b>\n${warnings.map((w) => `• ${w}`).join("\n")}`
    : "";
  const bodyPreview = body.length > TG_TEXT_MAX
    ? body.slice(0, TG_TEXT_MAX) + "\n…[truncated]"
    : body;
  return [
    `🧠 <b>New skill proposed: <code>${escapeHtml(name)}</code></b>`,
    "",
    `<i>${escapeHtml(description)}</i>`,
    warningBlock,
    "",
    "<pre>" + escapeHtml(bodyPreview) + "</pre>",
    "",
    "Choose an action:",
  ].filter(Boolean).join("\n");
}

export async function sendSkillApprovalMessage(
  params: SkillApprovalParams,
): Promise<{ ok: boolean; messageId: number | null }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[skill-approval] TELEGRAM_BOT_TOKEN not set — skipping notification");
    return { ok: false, messageId: null };
  }

  const text = buildMessage(params);
  const extra: Record<string, unknown> = {
    parse_mode: "HTML",
    reply_markup: buildKeyboard(params.skillId),
  };
  if (params.topicId !== undefined) {
    extra.message_thread_id = params.topicId;
  }

  const res = await sendTelegramMessage(token, params.chatId, text, extra);
  if (!res.ok) {
    console.warn("[skill-approval] sendMessage failed:", res.errorBody);
  }
  return { ok: res.ok, messageId: res.messageId };
}

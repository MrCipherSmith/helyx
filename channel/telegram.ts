/**
 * Pure Telegram HTTP helpers for the channel subprocess.
 * Leaf module — no imports from other channel/ modules.
 */

export async function editTelegramMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), message_id: messageId, text }),
    });
  } catch {}
}

export function deleteTelegramMessage(token: string, chatId: string, messageId: number): void {
  fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), message_id: messageId }),
  }).catch(() => {});
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null; errorBody?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text, ...extra }),
    });
    if (!res.ok) {
      const errorBody = await res.text();
      return { ok: false, messageId: null, errorBody };
    }
    const data = (await res.json()) as any;
    return { ok: true, messageId: data.result?.message_id ?? null };
  } catch (err) {
    return { ok: false, messageId: null, errorBody: String(err) };
  }
}

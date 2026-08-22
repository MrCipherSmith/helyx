/**
 * Sends "typing" chat action repeatedly until stopped.
 * Telegram typing indicator lasts ~5 seconds, so we resend every 4s.
 */

const TYPING_INTERVAL_MS = 4000;

export interface TypingHandle {
  stop: () => void;
}

export function startTyping(
  /** Resolves to the ms to wait before the next send — a 429's retry_after, typically. */
  sendAction: () => Promise<number | void>,
): TypingHandle {
  let running = true;

  const loop = async () => {
    while (running) {
      let wait = TYPING_INTERVAL_MS;
      try {
        const retryAfterMs = await sendAction();
        if (retryAfterMs) wait = Math.max(wait, retryAfterMs);
      } catch {
        // Ignore errors (chat may be gone)
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  };

  loop();

  return {
    stop: () => { running = false; },
  };
}

/**
 * Start typing via Telegram Bot API (for use in channel.ts without grammY).
 *
 * Backs off on 429 instead of resending on the fixed schedule regardless —
 * this call used to ignore its response entirely, so a rate-limited chat got
 * hit again every TYPING_INTERVAL_MS anyway, compounding the very limit it
 * had just been told to back off from.
 */
export function startTypingRaw(
  token: string,
  chatId: string | number,
): TypingHandle {
  return startTyping(async () => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), action: "typing" }),
    });
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      return (data.parameters?.retry_after ?? 5) * 1000;
    }
  });
}

/**
 * Sends "typing" chat action repeatedly until stopped.
 * Telegram typing indicator lasts ~5 seconds, so we resend every 4s.
 */

const TYPING_INTERVAL_MS = 4000;

export interface TypingHandle {
  stop: () => void;
}

export function startTyping(
  sendAction: () => Promise<void>,
): TypingHandle {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await sendAction();
      } catch {
        // Ignore errors (chat may be gone)
      }
      await new Promise((r) => setTimeout(r, TYPING_INTERVAL_MS));
    }
  };

  loop();

  return {
    stop: () => { running = false; },
  };
}

/**
 * Start typing via Telegram Bot API (for use in channel.ts without grammY)
 */
export function startTypingRaw(
  token: string,
  chatId: string | number,
): TypingHandle {
  return startTyping(async () => {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), action: "typing" }),
    });
  });
}

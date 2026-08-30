/**
 * Sends "typing" chat action repeatedly until stopped.
 * Telegram typing indicator lasts ~5 seconds, so we resend every 4s.
 */

import { acquireSendSlot } from "./telegram-rate-budget.ts";

const TYPING_INTERVAL_MS = 4000;

/**
 * A typing tick is cosmetic and gets resent every TYPING_INTERVAL_MS anyway,
 * so it must never queue for the shared rate budget indefinitely — with no
 * bound here it competes on equal footing with `telegramRequest`'s bounded,
 * deadline-limited acquire (channel/telegram.ts) and, under sustained
 * contention from ~10 concurrent sessions, wins by attrition: it never gives
 * up, so it keeps grabbing scarce tokens that a real reply — which does give
 * up after its own deadline — needed more. Skipping a tick costs nothing
 * (Telegram's own indicator lingers ~5s and the next tick is 4s away); losing
 * a reply does not get a next tick.
 */
const TYPING_SLOT_TIMEOUT_MS = 2000;

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
  /** Overridable for tests — production callers get TYPING_SLOT_TIMEOUT_MS. */
  slotTimeoutMs = TYPING_SLOT_TIMEOUT_MS,
): TypingHandle {
  return startTyping(async () => {
    // Shared cross-process gate (flow 064) — the same budget
    // channel/telegram.ts's telegramRequest gates on. Bounded: see
    // TYPING_SLOT_TIMEOUT_MS. A timeout here throws, which the caller's
    // existing catch-and-ignore (below, in startTyping's loop) already
    // treats as "skip this tick, try again next interval."
    await acquireSendSlot(slotTimeoutMs);
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

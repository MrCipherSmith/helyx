import { sql } from "./db.ts";
import { remember } from "./long-term.ts";
import { getCachedMessages, clearCache, type Message } from "./short-term.ts";
import { summarizeConversation } from "../claude/client.ts";
import { CONFIG } from "../config.ts";

// Idle timers: "sessionId:chatId" -> timeout handle
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(sessionId: number, chatId: string): string {
  return `${sessionId}:${chatId}`;
}

/**
 * Reset the idle timer for a session/chat.
 * Called after each new message.
 */
export function touchIdleTimer(sessionId: number, chatId: string): void {
  const key = timerKey(sessionId, chatId);

  // Clear existing timer
  const existing = idleTimers.get(key);
  if (existing) clearTimeout(existing);

  // Set new timer
  const timer = setTimeout(async () => {
    idleTimers.delete(key);
    await trySummarize(sessionId, chatId, "idle");
  }, CONFIG.IDLE_TIMEOUT_MS);

  idleTimers.set(key, timer);
}

/**
 * Check if message count exceeds threshold and summarize if needed.
 */
export async function checkOverflow(
  sessionId: number,
  chatId: string,
): Promise<void> {
  const messages = getCachedMessages(sessionId, chatId);
  if (!messages || messages.length < CONFIG.SHORT_TERM_WINDOW * 2) return;
  await trySummarize(sessionId, chatId, "overflow");
}

/**
 * Force summarize current conversation.
 */
export async function forceSummarize(
  sessionId: number,
  chatId: string,
): Promise<string | null> {
  return trySummarize(sessionId, chatId, "manual");
}

async function trySummarize(
  sessionId: number,
  chatId: string,
  trigger: "idle" | "overflow" | "manual",
): Promise<string | null> {
  // Get messages to summarize
  const rows = await sql`
    SELECT role, content FROM messages
    WHERE session_id = ${sessionId} AND chat_id = ${chatId}
    ORDER BY created_at DESC
    LIMIT ${CONFIG.SHORT_TERM_WINDOW * 2}
  `;

  if (rows.length < 4) return null; // Too few messages to summarize

  const messages = rows.reverse().map((r) => ({
    role: r.role as string,
    content: r.content as string,
  }));

  // Need API key for summarization
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`[summarizer] skipping (no API key), trigger=${trigger}, session=${sessionId}`);
    return null;
  }

  try {
    console.log(`[summarizer] summarizing ${messages.length} messages, trigger=${trigger}`);

    const { summary, facts } = await summarizeConversation(messages);

    // Save summary to long-term memory
    await remember({
      source: "telegram",
      sessionId,
      chatId,
      type: "summary",
      content: summary,
      tags: [trigger],
    });

    // Save extracted facts
    for (const fact of facts) {
      await remember({
        source: "telegram",
        sessionId,
        chatId,
        type: "fact",
        content: fact,
      });
    }

    console.log(`[summarizer] saved summary + ${facts.length} facts`);
    return summary;
  } catch (err) {
    console.error("[summarizer] failed:", err);
    return null;
  }
}

/**
 * Stop all idle timers (for graceful shutdown).
 */
export function stopAllTimers(): void {
  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();
}

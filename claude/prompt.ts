import type { MessageParam } from "./client.ts";
import { recall } from "../memory/long-term.ts";
import { getContext, getProjectHistory, type Message } from "../memory/short-term.ts";
import { sessionManager } from "../sessions/manager.ts";

/**
 * How much of one memory a prompt will carry.
 *
 * Generous for a summary, and small enough that no single row can dominate the
 * prompt it is supposed to inform.
 */
const MEMORY_CHARS_IN_PROMPT = 2_000;

function cap(content: string): string {
  return content.length <= MEMORY_CHARS_IN_PROMPT
    ? content
    : `${content.slice(0, MEMORY_CHARS_IN_PROMPT)}… [${content.length - MEMORY_CHARS_IN_PROMPT} more characters; recall this memory by id to read it]`;
}


export async function composePrompt(
  sessionId: number,
  chatId: string,
  currentMessage: string,
): Promise<{ system: string; messages: MessageParam[] }> {
  // Get session info
  const session = await sessionManager.get(sessionId);
  const projectPath = session?.projectPath ?? null;

  // 1. Get long-term memories relevant to current message (by project, not session)
  const memories = await recall(currentMessage, { projectPath, sessionId, limit: 5 });

  // 2. Get short-term context
  let history = await getContext(sessionId, chatId);

  // 3. If short-term context is thin and we have a project, load cross-session history
  if (history.length < 3 && projectPath) {
    const projectHistory = await getProjectHistory(projectPath, chatId);
    if (projectHistory.length > history.length) {
      history = projectHistory;
    }
  }

  // Build system prompt
  const parts: string[] = [
    "You are a helpful AI assistant. Reply in the language the user writes in.",
    `Current date: ${new Date().toISOString().split("T")[0]}.`,
  ];

  if (session && session.name && session.name !== "standalone") {
    parts.push(
      `Current session: "${session.name}"${session.projectPath ? ` (${session.projectPath})` : ""}.`,
    );
  }

  if (memories.length > 0) {
    parts.push("\n## Relevant memories from long-term memory:");
    for (const m of memories) {
      const dist = Number(m.distance).toFixed(3);
      // Capped. `recall` keeps transcript archives out of here, but that is one
      // filter away from a caller that passes `type` explicitly, and a system
      // prompt is the worst place in this system to discover a megabyte.
      parts.push(`- [${m.type}] ${cap(m.content)} (relevance: ${dist})`);
    }
  }

  const system = parts.join("\n");

  // Build messages array from short-term history
  const messages: MessageParam[] = history.map((msg: Message) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));

  // Add current message
  messages.push({ role: "user", content: currentMessage });

  return { system, messages };
}

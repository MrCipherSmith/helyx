import { sql } from "../memory/db.ts";
import type { CliAdapter, CliConfig, MessageMeta } from "./types.ts";

/**
 * DeepseekCliAdapter — runs Helyx's custom DeepSeek REPL wrapper inside a tmux window.
 *
 * The wrapper script (scripts/deepseek-repl.ts) calls the DeepSeek API via
 * Helyx's llm client. Like ClaudeCodeAdapter, send() inserts into message_queue.
 * The in-window stdin poller (Phase 7+) picks up and types into the REPL. For
 * Phase 6 MVP only the queueing path exists; in-window delivery is stubbed.
 */
export class DeepseekCliAdapter implements CliAdapter {
  readonly type = "deepseek-cli" as const;

  async send(sessionId: number, text: string, meta: MessageMeta): Promise<void> {
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (
        ${sessionId},
        ${meta.chatId},
        ${meta.fromUser},
        ${text},
        ${meta.messageId ?? ""}
      )
    `;
  }

  async isAlive(_config: CliConfig): Promise<boolean> {
    // session.status is the source of truth (same as ClaudeCodeAdapter).
    return true;
  }
}

export const deepseekCliAdapter = new DeepseekCliAdapter();

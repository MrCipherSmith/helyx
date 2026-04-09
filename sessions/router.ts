import { sessionManager } from "./manager.ts";
import { sql } from "../memory/db.ts";
import type { CliConfig } from "../adapters/types.ts";

export type RouteTarget =
  | { mode: "standalone"; sessionId: 0; projectPath?: null }
  | { mode: "cli"; sessionId: number; clientId: string; cliConfig: CliConfig; projectPath?: string | null }
  | { mode: "disconnected"; sessionId: number; sessionName: string | null; projectPath?: string | null };

/**
 * Resolve the route for an incoming message.
 *
 * @param chatId      The Telegram chat_id (DM or forum supergroup).
 * @param forumTopicId  Optional message_thread_id from a forum topic message.
 *                    When set and > 1, route is resolved by forum_topic_id → project.
 *                    topic_id=1 (General topic) falls through to chat_sessions lookup.
 */
export async function routeMessage(chatId: string, forumTopicId?: number): Promise<RouteTarget> {
  // Forum routing: topic > 1 → look up project by forum_topic_id
  if (forumTopicId !== undefined && forumTopicId > 1) {
    const rows = await sql`
      SELECT p.path, p.name,
             s.id    AS session_id,
             s.status,
             s.client_id,
             s.cli_config
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id AND s.source = 'remote'
      WHERE p.forum_topic_id = ${forumTopicId}
      LIMIT 1
    `;

    if (rows.length > 0) {
      const row = rows[0];
      if (!row.session_id || row.status !== "active") {
        return {
          mode: "disconnected",
          sessionId: row.session_id ?? 0,
          sessionName: row.name as string,
          projectPath: row.path as string,
        };
      }
      return {
        mode: "cli",
        sessionId: row.session_id as number,
        clientId: row.client_id as string,
        cliConfig: row.cli_config as CliConfig,
        projectPath: row.path as string,
      };
    }
    // No project mapped to this topic → fall through to DM routing
  }

  // Existing DM routing: look up active session via chat_sessions
  const sessionId = await sessionManager.getActiveSession(chatId);

  if (sessionId === 0) {
    return { mode: "standalone", sessionId: 0 };
  }

  const session = await sessionManager.get(sessionId);

  if (!session) {
    // Session was deleted, reset to standalone
    await sessionManager.switchSession(chatId, 0);
    return { mode: "standalone", sessionId: 0 };
  }

  if (session.status !== "active") {
    return { mode: "disconnected", sessionId, sessionName: session.name, projectPath: session.projectPath };
  }

  return {
    mode: "cli",
    sessionId,
    clientId: session.clientId,
    cliConfig: session.cliConfig as CliConfig,
    projectPath: session.projectPath,
  };
}

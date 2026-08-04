import { sessionManager } from "./manager.ts";
import { sql } from "../memory/db.ts";
import type { CliConfig } from "../adapters/types.ts";

export type RouteTarget =
  | { mode: "standalone"; sessionId: 0; projectPath?: null }
  | { mode: "cli"; sessionId: number; clientId: string; cliConfig: CliConfig; projectPath?: string | null }
  | { mode: "disconnected"; sessionId: number; sessionName: string | null; projectPath?: string | null };

/**
 * What routing needs from the outside world.
 *
 * Injected rather than imported, for the same reason the ask-question service
 * does it: this decides which session receives a message, and its most
 * consequential branch is one that must *not* happen — an unmapped topic
 * falling through to DM routing would deliver the operator's message to a
 * different project's session. A rule of that weight should be reachable by a
 * test, and with module-level imports it was not: the only existing test of
 * this file is a private reimplementation of its rules.
 */
export interface RouterDeps {
  sql: typeof sql;
  sessions: Pick<typeof sessionManager, "getActiveSession" | "get" | "switchSession">;
}

/**
 * Resolve the route for an incoming message.
 *
 * @param chatId      The Telegram chat_id (DM or forum supergroup).
 * @param forumTopicId  Optional message_thread_id from a forum topic message.
 *                    When set and > 1, route is resolved by forum_topic_id → project.
 *                    topic_id=1 (General topic) falls through to chat_sessions lookup.
 */
export async function routeMessage(
  chatId: string,
  forumTopicId?: number,
  deps: RouterDeps = { sql, sessions: sessionManager },
): Promise<RouteTarget> {
  // Forum routing: topic > 1 → look up project by forum_topic_id
  if (forumTopicId !== undefined && forumTopicId > 1) {
    const rows = await deps.sql`
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
    // No project mapped to this topic → return disconnected (sessionId=0) so callers
    // can show "topic not configured" rather than falling through to DM routing,
    // which could accidentally deliver the message to another project's session.
    return { mode: "disconnected", sessionId: 0, sessionName: null, projectPath: null };
  }

  // Existing DM routing: look up active session via chat_sessions
  const sessionId = await deps.sessions.getActiveSession(chatId);

  if (sessionId === 0) {
    return { mode: "standalone", sessionId: 0 };
  }

  const session = await deps.sessions.get(sessionId);

  if (!session) {
    // Session was deleted, reset to standalone
    await deps.sessions.switchSession(chatId, 0);
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

/**
 * Session state machine — formal status transitions with validation and logging.
 *
 * Valid transitions:
 *   active    → inactive    (remote channel disconnects, can reconnect)
 *   active    → terminated  (local channel disconnects, awaiting cleanup)
 *   inactive  → active      (remote channel reconnects)
 *   inactive  → terminated  (stale remote session cleaned up)
 *   terminated → [deleted]  (cleanup job — not a status transition)
 */

import type postgres from "postgres";
import { logger } from "../logger.ts";
import { broadcast } from "../mcp/notification-broadcaster.ts";

export type SessionStatus = "active" | "inactive" | "terminated";

// Map of valid target states from each source state
const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  active:     ["inactive", "terminated"],
  inactive:   ["active", "terminated"],
  terminated: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Atomically transition a session to a new status.
 * Only applies the UPDATE if the current status allows the transition.
 * Returns true if the transition was applied, false if blocked or session not found.
 */
export async function transitionSession(
  sql: postgres.Sql,
  sessionId: number,
  to: SessionStatus,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  // Build the set of valid source states for this target
  const validFrom = (Object.keys(TRANSITIONS) as SessionStatus[]).filter(
    (from) => TRANSITIONS[from].includes(to),
  );

  if (validFrom.length === 0) {
    logger.warn({ sessionId, to }, "no valid source states for transition — blocked");
    return false;
  }

  const result = await sql`
    UPDATE sessions
    SET status = ${to}, last_active = now()
    WHERE id = ${sessionId}
      AND status = ANY(${validFrom})
    RETURNING id, project, status
  `;

  if (result.length === 0) {
    // Either session not found, or current status didn't allow the transition
    const [row] = await sql`SELECT status FROM sessions WHERE id = ${sessionId}`;
    if (!row) {
      logger.warn({ sessionId, to }, "session not found for transition");
    } else {
      logger.warn({ sessionId, from: row.status, to }, "invalid session transition blocked");
    }
    return false;
  }

  logger.info({ sessionId, to, ...meta }, "session transitioned");
  try {
    broadcast("session-state", { id: sessionId, status: to, project: result[0].project });
  } catch {}
  return true;
}

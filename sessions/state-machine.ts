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

  // `FROM sessions prev` reads the row as it was before this statement, so the
  // status being left is returned alongside the one being taken. Without it the
  // audit row below could only ever say where a session ended up, and "active →
  // inactive" and "inactive → inactive" are not the same event.
  const result = await sql`
    UPDATE sessions s
    SET status = ${to}, last_active = now()
    FROM sessions prev
    WHERE prev.id = s.id
      AND s.id = ${sessionId}
      AND s.status = ANY(${validFrom})
    RETURNING s.id, s.project, s.status, prev.status AS from_status
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

  // The durable half of the same fact. `sessions.status` is a single mutable
  // column, and `tmuxStop` rewrites every remote row in one statement — so
  // until flow 067 nothing survived a restart to say which sessions had been
  // running, or who stopped them. Recorded after the UPDATE and never in front
  // of it: an audit row for a transition that did not happen is worse than a
  // missing one, which is also why a failed INSERT here does not fail the
  // transition that already committed.
  const reason = typeof meta?.reason === "string" ? meta.reason : null;
  const actor = typeof meta?.actor === "string" ? meta.actor : null;
  try {
    await sql`
      INSERT INTO session_state_events (session_id, project, from_status, to_status, reason, actor)
      VALUES (
        ${sessionId},
        ${result[0].project ?? null},
        ${result[0].from_status ?? null},
        ${to},
        ${reason},
        ${actor}
      )
    `;
  } catch (err) {
    logger.warn({ sessionId, to, err }, "session transition recorded in sessions but not in session_state_events");
  }

  try {
    broadcast("session-state", { id: sessionId, status: to, project: result[0].project });
  } catch {}
  return true;
}

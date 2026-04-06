import { sql } from "../memory/db.ts";

/**
 * Delete a session and all related data in a single transaction.
 */
export async function deleteSessionCascade(sessionId: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM chat_sessions WHERE active_session_id = ${sessionId}`;
    await tx`DELETE FROM permission_requests WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM message_queue WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM request_logs WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM api_request_stats WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM transcription_stats WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM messages WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM memories WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM sessions WHERE id = ${sessionId}`;
  });
}

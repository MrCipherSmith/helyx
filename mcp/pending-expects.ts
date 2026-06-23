/**
 * Shared registry of pending expect registrations.
 * channel.ts calls POST /api/sessions/expect → stored here.
 *
 * Bidirectional linking strategy:
 *   - If an unlinked transport is already waiting when expect arrives → link immediately.
 *   - If expect arrives before any transport → queue it; tryAutoLink() consumes it on transport init.
 *
 * Uses a session-keyed Map so re-registration (e.g. from channel.ts heartbeat) is idempotent
 * and doesn't create duplicate entries that could mismatch across sessions.
 */
import { sessionManager } from "../sessions/manager.ts";

const EXPECT_TTL_MS = 300_000; // 5 minutes — outlives any supervisor restart cycle

// sessionId → timestamp of registration
const pendingExpects = new Map<number, number>();

// Exposed for server.ts console.log (queue length)
export { pendingExpects };

export async function pushExpect(sessionId: number): Promise<void> {
  // Evict stale entries
  const now = Date.now();
  for (const [sid, ts] of pendingExpects) {
    if (now - ts > EXPECT_TTL_MS) pendingExpects.delete(sid);
  }

  // Fast path: transport already waiting (race won by Claude Code startup)
  const unlinked = sessionManager.getUnlinkedTransports();
  if (unlinked.length > 0) {
    // Pick the most recently tracked transport — most likely the one that just started
    const clientId = unlinked[unlinked.length - 1];
    await sessionManager.linkClientToSession(clientId, sessionId);
    return;
  }

  // Queue for when transport arrives
  pendingExpects.set(sessionId, now);
}

/**
 * Try to auto-link an HTTP MCP transport to a pending channel.ts session.
 * Called at transport init AND on every tool call from an unlinked transport.
 * Safe to call multiple times — no-op if already linked or no pending expect.
 */
export async function tryAutoLink(clientId: string): Promise<void> {
  if (sessionManager.getSessionIdByClient(clientId) !== undefined) return;
  const now = Date.now();
  for (const [sid, ts] of pendingExpects) {
    if (now - ts > EXPECT_TTL_MS) {
      pendingExpects.delete(sid);
      continue;
    }
    pendingExpects.delete(sid);
    await sessionManager.linkClientToSession(clientId, sid);
    return;
  }
}

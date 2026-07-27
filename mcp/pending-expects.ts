/**
 * Shared registry of pending expect registrations.
 * channel.ts calls POST /api/sessions/expect → stored here.
 *
 * Linking strategy (identity-first):
 *   1. If the transport reported its project path (X-Helyx-Project header) →
 *      link to the remote session with that exact project_path. Never guess.
 *   2. Transports WITHOUT a known project path fall back to the expect queue,
 *      but only to expects that also lack a project_path (legacy channel.ts),
 *      so an anonymous transport can never steal a path-scoped expect.
 *
 * This replaces the old timing-based lottery where pushExpect() grabbed the
 * most recent unlinked transport and tryAutoLink() grabbed the first queued
 * expect — with 4+ concurrent CLI sessions that crossed transports between
 * projects (e.g. the deprecated CLI got linked as vantage-frontend).
 */
import { sessionManager } from "../sessions/manager.ts";
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";


const EXPECT_TTL_MS = 300_000; // 5 minutes — outlives any supervisor restart cycle

interface PendingExpect {
  ts: number;
  projectPath: string | null;
}

// sessionId → expect registration
const pendingExpects = new Map<number, PendingExpect>();

// transport clientId → project path reported at transport init (X-Helyx-Project)
const transportProjects = new Map<string, string>();

// Exposed for server.ts console.log (queue length)
export { pendingExpects };

/** Record the project path a transport declared at init (from X-Helyx-Project header). */
export function rememberTransportProject(clientId: string, projectPath: string): void {
  transportProjects.set(clientId, projectPath);
}

export function forgetTransportProject(clientId: string): void {
  transportProjects.delete(clientId);
}

function evictStaleExpects(now: number): void {
  for (const [sid, entry] of pendingExpects) {
    if (now - entry.ts > EXPECT_TTL_MS) pendingExpects.delete(sid);
  }
}

/** Link a transport to the remote session owning the given project path. */
async function linkByProjectPath(clientId: string, projectPath: string): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM sessions
    WHERE project_path = ${projectPath} AND source = 'remote'
    ORDER BY last_active DESC
    LIMIT 1
  `;
  if (rows.length === 0) return false;
  const sessionId = rows[0].id as number;
  pendingExpects.delete(sessionId);
  await sessionManager.linkClientToSession(clientId, sessionId);
  return true;
}

export async function pushExpect(sessionId: number, projectPath?: string | null): Promise<void> {
  const now = Date.now();
  evictStaleExpects(now);

  const path = projectPath ?? null;

  // Fast path: an unlinked transport that declared THIS project path is waiting
  if (path) {
    for (const clientId of sessionManager.getUnlinkedTransports()) {
      if (transportProjects.get(clientId) === path) {
        await sessionManager.linkClientToSession(clientId, sessionId);
        return;
      }
    }
    pendingExpects.set(sessionId, { ts: now, projectPath: path });
    return;
  }

  // Legacy expect without a path: only match transports that ALSO have no
  // declared path — never claim a transport that belongs to a known project.
  const anonymous = sessionManager
    .getUnlinkedTransports()
    .filter((id) => !transportProjects.has(id));
  if (anonymous.length > 0) {
    const clientId = anonymous[anonymous.length - 1];
    await sessionManager.linkClientToSession(clientId, sessionId);
    return;
  }

  pendingExpects.set(sessionId, { ts: now, projectPath: null });
}

/**
 * Try to auto-link an HTTP MCP transport to a pending channel.ts session.
 * Called at transport init AND on every tool call from an unlinked transport.
 * Safe to call multiple times — no-op if already linked or no pending expect.
 */
export async function tryAutoLink(clientId: string): Promise<void> {
  if (sessionManager.getSessionIdByClient(clientId) !== undefined) return;
  const now = Date.now();
  evictStaleExpects(now);

  const declaredPath = transportProjects.get(clientId);

  // Identity path: transport declared its project — link only by exact match.
  if (declaredPath) {
    const linked = await linkByProjectPath(clientId, declaredPath);
    if (!linked) {
      logger.warn(
        { clientId: clientId.slice(0, 12), declaredPath },
        "transport declared project path but no remote session matches — leaving unlinked",
      );
    }
    return;
  }

  // Anonymous transport: only consume expects that also have no project path.
  for (const [sid, entry] of pendingExpects) {
    if (entry.projectPath !== null) continue;
    pendingExpects.delete(sid);
    await sessionManager.linkClientToSession(clientId, sid);
    return;
  }

  // Unambiguous fallback for degraded setups (CLI launched without
  // HELYX_PROJECT_PATH): exactly one pending expect and this is the only
  // unlinked transport — pairing cannot cross. With multiple sessions
  // restarting there are several expects pending, so this never fires there.
  if (pendingExpects.size === 1 && sessionManager.getUnlinkedTransports().length === 1) {
    const [sid] = pendingExpects.keys();
    pendingExpects.delete(sid);
    await sessionManager.linkClientToSession(clientId, sid);
  }
}

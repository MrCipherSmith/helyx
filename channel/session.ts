/**
 * Session lifecycle — resolveSession(), lease-based ownership, idle timer.
 *
 * Replaces pg_advisory_lock with a TTL lease stored in the sessions table.
 * The lease_owner identifies this process uniquely; lease_expires_at is renewed
 * every heartbeat. If the process crashes, the lease auto-expires and another
 * channel.ts process can take over after the TTL (3 minutes).
 */

import type postgres from "postgres";
import { channelLogger } from "../logger.ts";
import { transitionSession, type SessionStatus } from "../sessions/state-machine.ts";

export interface SessionContext {
  sql: postgres.Sql;
  projectName: string;
  projectPath: string;
  channelSource: "remote" | "local" | null;
  botApiUrl: string;
  idleTimeoutMs: number;
}

const LEASE_TTL = "3 minutes";
const LEASE_RETRY_DELAY_MS = 1000;
/**
 * 20 attempts at 1s apart — 20 seconds of retrying before falling through to
 * the stale-or-live decision below.
 *
 * Was 5 (5 seconds) until the 2026-10-08/09 vantage-frontend incident: when
 * run-cli.sh restarts `claude` for this same project, the new channel.ts's
 * very first acquire attempts race against its own dying predecessor, whose
 * `releaseLease()` (a DB round trip on its own shutdown path) hadn't
 * completed yet. Five seconds wasn't enough margin, so `acquireLease()` kept
 * failing, the loop fell through to the OWNER_STALE_AFTER_MS check below
 * with the predecessor's heartbeat still looking fresh (it was 4 seconds
 * old), concluded a live owner held it, and exited — leaving `claude` alive
 * with no channel for the next 5.5 hours, because nothing watching this host
 * restarts `claude` itself; only a dead *channel* gets flagged, and only a
 * human pressing the alert's restart button fixes it. Twenty seconds is
 * still a fifth of OWNER_STALE_AFTER_MS, so a genuine stray foreign process
 * is still correctly left alone — it just gives this project's own previous
 * instance realistic time to finish dying first.
 */
const LEASE_MAX_ATTEMPTS = 20;
/**
 * How stale `last_active` must be before a contended lease is treated as
 * abandoned rather than merely busy. `renewLease()`'s heartbeat runs every
 * 60s (`HEARTBEAT_INTERVAL_MS` in channel/index.ts), so anything fresher than
 * that is a session that is, right now, actively renewing — 1.5x gives one
 * heartbeat's slack for scheduling jitter before calling it dead.
 */
const OWNER_STALE_AFTER_MS = 90_000;

/**
 * Thrown by `resolve()` when a `remote` session's lease is held by a process
 * whose heartbeat is still fresh. The caller (a stray or nested invocation —
 * a subagent, `keryx shell`, a manual one-shot `claude -p` — that happened to
 * load this MCP server and land on the same project) must not become this
 * session's channel: there is already a live owner, and stealing from it is
 * exactly the incident this class exists to prevent (see channel/index.ts's
 * catch site).
 */
export class LiveOwnerExistsError extends Error {
  constructor(readonly sessionId: number) {
    super(`session ${sessionId}'s lease is held by a live owner — refusing to steal it`);
    this.name = "LiveOwnerExistsError";
  }
}

export class SessionManager {
  sessionId: number | null = null;
  sessionName: string;
  private leaseOwner: string;
  private leaseAcquired = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: SessionContext) {
    this.sessionName = `${ctx.projectName} · ${ctx.channelSource ?? "standalone"}`;
    this.leaseOwner = `ch-${ctx.projectName}-${ctx.channelSource ?? "x"}-${Date.now()}`;
  }

  // --- Lease helpers ---

  private async acquireLease(sessionId: number): Promise<boolean> {
    const result = await this.ctx.sql`
      UPDATE sessions
      SET lease_owner = ${this.leaseOwner},
          lease_expires_at = now() + ${LEASE_TTL}::interval
      WHERE id = ${sessionId}
        AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = ${this.leaseOwner})
      RETURNING id
    `;
    return result.length > 0;
  }

  /**
   * Renew the lease. Returns false if the lease was lost to another process —
   * the caller should trigger a graceful shutdown so only one channel.ts owns the session.
   */
  async renewLease(): Promise<boolean> {
    if (!this.leaseAcquired || this.sessionId === null) return true;
    const result = await this.ctx.sql`
      UPDATE sessions
      SET lease_expires_at = now() + ${LEASE_TTL}::interval,
          last_active = now()
      WHERE id = ${this.sessionId} AND lease_owner = ${this.leaseOwner}
      RETURNING id
    `;
    if (result.length === 0) {
      channelLogger.warn({ sessionId: this.sessionId, owner: this.leaseOwner }, "lease lost — another process took ownership, shutting down");
      this.leaseAcquired = false;
      return false;
    }
    return true;
  }

  private async releaseLease(): Promise<void> {
    if (!this.leaseAcquired || this.sessionId === null) return;
    await this.ctx.sql`
      UPDATE sessions SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${this.sessionId} AND lease_owner = ${this.leaseOwner}
    `.catch(() => {});
    this.leaseAcquired = false;
    channelLogger.info({ sessionId: this.sessionId }, "lease released");
  }

  // --- Session resolution ---

  async resolve(): Promise<number> {
    const { sql, projectName, projectPath, channelSource } = this.ctx;

    if (channelSource === null) {
      channelLogger.info("standalone mode — no DB registration");
      return -1;
    }

    if (channelSource === "local") {
      const clientId = `channel-${projectName}-local-${Date.now()}`;
      const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
      const projectId = proj?.id ?? null;
      const [row] = await sql`
        INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status)
        VALUES (${this.sessionName}, ${projectName}, 'local', ${projectPath}, ${projectId}, ${clientId}, 'active')
        RETURNING id
      `;
      this.sessionId = row.id;
      const acquired = await this.acquireLease(this.sessionId!);
      if (acquired) this.leaseAcquired = true;
      channelLogger.info({ sessionId: this.sessionId, name: this.sessionName }, "created local session");
      return this.sessionId!;
    }

    // Remote session — reuse existing or create new
    const existing = await sql`
      SELECT id FROM sessions
      WHERE project = ${projectName} AND source = 'remote' AND id != 0
      ORDER BY last_active DESC
      LIMIT 1
    `;

    if (existing.length > 0) {
      for (let attempt = 0; attempt < LEASE_MAX_ATTEMPTS; attempt++) {
        const acquired = await this.acquireLease(existing[0].id);
        if (acquired) {
          this.sessionId = existing[0].id;
          this.leaseAcquired = true;
          const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
          await sql`UPDATE sessions SET status = 'active', last_active = now(), project_id = ${proj?.id ?? null} WHERE id = ${this.sessionId!}`;
          channelLogger.info({ sessionId: this.sessionId, name: this.sessionName }, "attached to remote session");
          return this.sessionId!;
        }
        if (attempt < LEASE_MAX_ATTEMPTS - 1) {
          channelLogger.warn({ name: this.sessionName, attempt: attempt + 1 }, "session lease held by another process, retrying");
          await new Promise((r) => setTimeout(r, LEASE_RETRY_DELAY_MS));
        }
      }
      // Lease held by another process for the whole retry window. That alone
      // does not mean it is dead — acquireLease()'s own WHERE clause only ever
      // succeeds against an expired lease, so five straight failures just as
      // easily mean a live owner is renewing it every heartbeat as they mean a
      // stale subprocess from a previous bounce. last_active (touched by the
      // same heartbeat, every 60s) tells the two apart: fresh means someone is
      // genuinely home right now, and stealing from that owner is the 2026-09
      // incident — a nested claude invocation (subagent, `keryx shell`, a
      // one-shot `claude -p`) landed on the same project via the global MCP
      // registration, contended for five seconds, then force-stole the lease
      // out from under the session actually serving the operator.
      const [ownerRow] = await sql`
        SELECT last_active FROM sessions WHERE id = ${existing[0].id}
      `;
      const lastActiveMs = ownerRow?.last_active ? new Date(ownerRow.last_active as string).getTime() : 0;
      if (Date.now() - lastActiveMs < OWNER_STALE_AFTER_MS) {
        channelLogger.info(
          { existingId: existing[0].id, lastActive: ownerRow?.last_active },
          "remote session lease held by a live owner — not stealing it",
        );
        throw new LiveOwnerExistsError(existing[0].id as number);
      }

      // The owner's heartbeat has gone quiet well past one cycle — genuinely
      // abandoned, not merely busy. Force-steal the lease on the existing
      // session; creating a new row would violate the
      // idx_sessions_project_remote unique constraint anyway.
      channelLogger.warn({ existingId: existing[0].id, lastActive: ownerRow?.last_active }, "remote session lease held after max attempts, owner heartbeat stale — force-stealing lease");
      await sql`
        UPDATE sessions
        SET lease_owner = ${this.leaseOwner},
            lease_expires_at = now() + ${LEASE_TTL}::interval,
            status = 'active',
            last_active = now()
        WHERE id = ${existing[0].id}
      `;
      this.sessionId = existing[0].id as number;
      this.leaseAcquired = true;
      const [proj2] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
      await sql`UPDATE sessions SET project_id = ${proj2?.id ?? null} WHERE id = ${this.sessionId!}`;
      channelLogger.info({ sessionId: this.sessionId, name: this.sessionName }, "attached to remote session (force-stolen lease)");
      return this.sessionId!;
    }

    const clientId = `channel-${projectName}-remote-${Date.now()}`;
    const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
    const projectId = proj?.id ?? null;
    const [row] = await sql`
      INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status)
      VALUES (${this.sessionName}, ${projectName}, 'remote', ${projectPath}, ${projectId}, ${clientId}, 'active')
      RETURNING id
    `;
    this.sessionId = row.id as number;
    this.leaseAcquired = true;
    const acquired = await this.acquireLease(this.sessionId!);
    if (!acquired) {
      channelLogger.warn({ sessionId: this.sessionId }, "failed to acquire lease on newly created session (race?)");
    }
    channelLogger.info({ sessionId: this.sessionId, name: this.sessionName }, "created remote session");

    // Transfer chat routing from old sessions
    await sql`
      UPDATE chat_sessions SET active_session_id = ${this.sessionId}
      WHERE active_session_id IN (
        SELECT id FROM sessions WHERE project_path = ${projectPath} AND id != ${this.sessionId}
      )
    `;
    await sql`
      DELETE FROM sessions
      WHERE project_path = ${projectPath}
        AND id != ${this.sessionId}
        AND status IN ('disconnected', 'inactive')
        AND (client_id LIKE 'claude-%' OR client_id LIKE 'channel-%')
    `;

    return this.sessionId!;
  }

  // --- Idle timer ---

  touchIdleTimer(onIdle: () => Promise<void>): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null;
      await onIdle();
    }, this.ctx.idleTimeoutMs);
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // --- Summarization ---

  async triggerSummarize(): Promise<void> {
    if (this.sessionId === null) return;
    const { botApiUrl, projectPath, channelSource } = this.ctx;
    try {
      if (channelSource === "local") {
        channelLogger.info({ sessionId: this.sessionId }, "triggering work summary for local session");
        await fetch(`${botApiUrl}/api/sessions/${this.sessionId}/summarize-work`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.sessionId }),
          signal: AbortSignal.timeout(5_000),
        });
      } else {
        channelLogger.info({ sessionId: this.sessionId }, "triggering summarization");
        await fetch(`${botApiUrl}/api/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.sessionId, project_path: projectPath }),
          signal: AbortSignal.timeout(5_000),
        });
      }
    } catch (err) {
      channelLogger.error({ err }, "summarize request failed");
    }
  }

  // --- Disconnect ---

  async markDisconnected(): Promise<void> {
    if (this.sessionId === null) return;
    await this.triggerSummarize();
    try {
      const newStatus: SessionStatus = this.ctx.channelSource === "remote" ? "inactive" : "terminated";
      await transitionSession(this.ctx.sql, this.sessionId, newStatus);
      await this.releaseLease();
    } catch (err) {
      channelLogger.error({ err }, "failed to mark disconnected");
    }
  }
}

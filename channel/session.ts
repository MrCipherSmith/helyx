/**
 * Session lifecycle — resolveSession(), markDisconnected(), idle timer.
 */

import type postgres from "postgres";

export interface SessionContext {
  sql: postgres.Sql;
  projectName: string;
  projectPath: string;
  channelSource: "remote" | "local" | null;
  botApiUrl: string;
  idleTimeoutMs: number;
}

export class SessionManager {
  sessionId: number | null = null;
  sessionName: string;
  hasPollingLock = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: SessionContext) {
    this.sessionName = `${ctx.projectName} · ${ctx.channelSource ?? "standalone"}`;
  }

  async resolve(): Promise<number> {
    const { sql, projectName, projectPath, channelSource } = this.ctx;

    if (channelSource === null) {
      process.stderr.write(`[channel] standalone mode — no DB registration\n`);
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
      this.hasPollingLock = true;
      await sql`SELECT pg_advisory_lock(${this.sessionId!})`;
      process.stderr.write(`[channel] created local session #${this.sessionId} (${this.sessionName})\n`);
      return this.sessionId!;
    }

    // Remote session — reuse existing or create new
    const existing = await sql`
      SELECT id FROM sessions
      WHERE project = ${projectName} AND source = 'remote' AND id != 0
      LIMIT 1
    `;

    if (existing.length > 0) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const lockResult = await sql`SELECT pg_try_advisory_lock(${existing[0].id}) as locked`;
        if (lockResult[0].locked) {
          this.sessionId = existing[0].id;
          this.hasPollingLock = true;
          const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
          await sql`UPDATE sessions SET status = 'active', last_active = now(), project_id = ${proj?.id ?? null} WHERE id = ${this.sessionId!}`;
          process.stderr.write(`[channel] attached to remote session #${this.sessionId} (${this.sessionName})\n`);
          return this.sessionId!;
        }
        if (attempt < 4) {
          process.stderr.write(`[channel] session "${this.sessionName}" locked, retrying (${attempt + 1}/5)...\n`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      process.stderr.write(`[channel] remote session for project already active, exiting\n`);
      process.exit(0);
    }

    const clientId = `channel-${projectName}-remote-${Date.now()}`;
    const [proj] = await sql`SELECT id FROM projects WHERE path = ${projectPath}`;
    const projectId = proj?.id ?? null;
    const [row] = await sql`
      INSERT INTO sessions (name, project, source, project_path, project_id, client_id, status)
      VALUES (${this.sessionName}, ${projectName}, 'remote', ${projectPath}, ${projectId}, ${clientId}, 'active')
      RETURNING id
    `;
    this.sessionId = row.id;
    this.hasPollingLock = true;
    await sql`SELECT pg_advisory_lock(${this.sessionId})`;
    process.stderr.write(`[channel] created remote session #${this.sessionId} (${this.sessionName})\n`);

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
        AND status = 'disconnected'
        AND client_id LIKE 'claude-%'
    `;

    return this.sessionId!;
  }

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

  async triggerSummarize(): Promise<void> {
    if (this.sessionId === null) return;
    const { botApiUrl, projectPath, channelSource } = this.ctx;
    try {
      if (channelSource === "local") {
        process.stderr.write(`[channel] triggering work summary for local session #${this.sessionId}\n`);
        await fetch(`${botApiUrl}/api/sessions/${this.sessionId}/summarize-work`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.sessionId }),
        });
      } else {
        process.stderr.write(`[channel] triggering summarization for session #${this.sessionId}\n`);
        await fetch(`${botApiUrl}/api/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.sessionId, project_path: projectPath }),
        });
      }
    } catch (err) {
      process.stderr.write(`[channel] summarize request failed: ${err}\n`);
    }
  }

  async markDisconnected(releasePollingLock: () => Promise<void>): Promise<void> {
    if (this.sessionId === null) return;
    await this.triggerSummarize();
    try {
      const newStatus = this.ctx.channelSource === "remote" ? "inactive" : "terminated";
      await this.ctx.sql`
        UPDATE sessions SET status = ${newStatus}, last_active = now()
        WHERE id = ${this.sessionId}
      `;
      process.stderr.write(`[channel] session #${this.sessionId} marked ${newStatus}\n`);
      if (this.hasPollingLock) {
        await releasePollingLock();
        process.stderr.write(`[channel] released polling lock\n`);
      }
    } catch (err) {
      process.stderr.write(`[channel] failed to mark disconnected: ${err}\n`);
    }
  }
}

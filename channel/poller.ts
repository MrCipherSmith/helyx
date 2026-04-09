/**
 * MessageQueuePoller — LISTEN/NOTIFY + polling loop.
 */

import type postgres from "postgres";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StatusManager } from "./status.ts";

export interface PollerContext {
  sql: postgres.Sql;
  mcp: Server;
  sessionId: () => number | null;
  pollIntervalMs: number;
  databaseUrl: string;
}

export class MessageQueuePoller {
  private polling = true;
  private wakeResolve: (() => void) | null = null;

  constructor(
    private ctx: PollerContext,
    private status: StatusManager,
    private touchIdleTimer: () => void,
  ) {}

  async acquirePollingLock(): Promise<boolean> {
    const sessionId = this.ctx.sessionId();
    if (sessionId === null) return false;
    const result = await this.ctx.sql`SELECT pg_try_advisory_lock(${sessionId}) as locked`;
    return result[0].locked;
  }

  async releasePollingLock(): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (sessionId === null) return;
    await this.ctx.sql`SELECT pg_advisory_unlock(${sessionId})`.catch(() => {});
  }

  private async setupListenNotify(): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (sessionId === null) return;
    try {
      const { default: postgres } = await import("postgres");
      const listenSql = postgres(this.ctx.databaseUrl, { max: 1 });
      await listenSql.listen(`message_queue_${sessionId}`, () => {
        if (this.wakeResolve) { this.wakeResolve(); this.wakeResolve = null; }
      });
      process.stderr.write(`[channel] LISTEN/NOTIFY active for session #${sessionId}\n`);
    } catch (err) {
      process.stderr.write(`[channel] LISTEN/NOTIFY setup failed, falling back to polling: ${err}\n`);
    }
  }

  private waitForWakeOrTimeout(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
      setTimeout(() => { this.wakeResolve = null; resolve(); }, this.ctx.pollIntervalMs);
    });
  }

  stop(): void {
    this.polling = false;
    if (this.wakeResolve) { this.wakeResolve(); this.wakeResolve = null; }
  }

  async start(): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (sessionId !== null) await this.setupListenNotify();

    while (this.polling) {
      try {
        const sid = this.ctx.sessionId();
        if (sid === null) {
          await new Promise((r) => setTimeout(r, this.ctx.pollIntervalMs));
          continue;
        }

        const rows = await this.ctx.sql`
          UPDATE message_queue
          SET delivered = true
          WHERE id IN (
            SELECT id FROM message_queue
            WHERE session_id = ${sid} AND delivered = false
            ORDER BY created_at
            LIMIT 10
          )
          RETURNING id, chat_id, from_user, content, message_id, created_at
        `;

        for (const row of rows) {
          process.stderr.write(`[channel] polling found msg #${row.id} for session ${sid}: ${row.content.slice(0, 50)}\n`);
          this.status.startTypingForChat(row.chat_id);
          await this.status.sendStatusMessage(row.chat_id, "Thinking...");
          await this.status.startProgressMonitorForChat(row.chat_id);

          await this.ctx.mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: row.content,
              meta: {
                chat_id: row.chat_id,
                user: row.from_user,
                message_id: row.message_id || undefined,
                ts: new Date(row.created_at).toISOString(),
              },
            },
          });
          process.stderr.write(`[channel] delivered message from ${row.from_user}: ${row.content.slice(0, 50)}\n`);
          this.touchIdleTimer();
        }
      } catch (err) {
        process.stderr.write(`[channel] poll error: ${err}\n`);
      }

      await this.waitForWakeOrTimeout();
    }
  }
}

/**
 * StatusManager — Telegram status messages + typing indicators + progress monitor.
 */

import type postgres from "postgres";
import { startTypingRaw, type TypingHandle } from "../utils/typing.ts";
import { startTmuxMonitor, type TmuxMonitorHandle } from "../utils/tmux-monitor.ts";
import { startOutputMonitor, getOutputFilePath, type OutputMonitorHandle } from "../utils/output-monitor.ts";
import { editTelegramMessage, deleteTelegramMessage, sendTelegramMessage } from "./telegram.ts";
import { channelLogger } from "../logger.ts";

export interface StatusContext {
  sql: postgres.Sql;
  sessionId: () => number | null;
  sessionName: () => string;
  projectName: string;
  token: () => string | undefined;
}

interface StatusState {
  chatId: string;
  messageId: number;
  startedAt: number;
  stage: string;
  timer: ReturnType<typeof setInterval> | null;
}

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export class StatusManager {
  private activeStatus = new Map<string, StatusState>();
  private lastTokenInfo = new Map<string, string>();
  private activeTyping = new Map<string, TypingHandle>();
  private activeMonitors = new Map<string, TmuxMonitorHandle | OutputMonitorHandle>();
  private readonly TYPING_TIMEOUT_MS = 30_000;

  constructor(private ctx: StatusContext) {}

  private async getSessionPrefix(chatId: string): Promise<string> {
    const sessionId = this.ctx.sessionId();
    if (!sessionId) return "";
    const activeCheck = await this.ctx.sql`
      SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
    `;
    const isActive = activeCheck.length === 0 || activeCheck[0].active_session_id === sessionId;
    return isActive ? "" : `📌 ${this.ctx.sessionName()} · `;
  }

  async sendStatusMessage(chatId: string, stage: string): Promise<string | null> {
    const token = this.ctx.token();
    if (!token) {
      channelLogger.warn("sendStatusMessage: no TELEGRAM_BOT_TOKEN");
      return "no TELEGRAM_BOT_TOKEN";
    }

    const prefix = await this.getSessionPrefix(chatId);
    const existing = this.activeStatus.get(chatId);

    if (existing) {
      if (existing.stage !== `${prefix}${stage}`) {
        // Stage changed — delete old and send new at bottom
        try {
          await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: Number(chatId), message_id: existing.messageId }),
          });
        } catch {}
        if (existing.timer) clearInterval(existing.timer);
        this.activeStatus.delete(chatId);
        // Fall through to create new
      } else {
        await this.editStatusMessage(existing);
        return null;
      }
    }

    try {
      const result = await sendTelegramMessage(token, chatId, `⏳ ${prefix}${stage}`);
      if (!result.ok) {
        channelLogger.warn({ error: result.errorBody }, "sendStatusMessage failed");
        return `Telegram API error`;
      }

      const prevStartedAt = existing?.startedAt;
      const state: StatusState = {
        chatId,
        messageId: result.messageId!,
        startedAt: prevStartedAt ?? Date.now(),
        stage: `${prefix}${stage}`,
        timer: null,
      };
      state.timer = setInterval(() => this.editStatusMessage(state), 5000);
      this.activeStatus.set(chatId, state);
      channelLogger.info({ chatId, messageId: state.messageId }, "status message created");
      return null;
    } catch (e) {
      channelLogger.error({ err: e }, "sendStatusMessage exception");
      return `Exception: ${e}`;
    }
  }

  async updateStatus(chatId: string, stage: string): Promise<void> {
    const state = this.activeStatus.get(chatId);
    if (!state) {
      await this.sendStatusMessage(chatId, stage);
      return;
    }
    state.stage = stage;
    await this.editStatusMessage(state);
  }

  private async editStatusMessage(state: StatusState): Promise<void> {
    const token = this.ctx.token();
    if (!token) return;
    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const tokens = this.lastTokenInfo.get(state.chatId);
    const tokenStr = tokens ? ` · ↓ ${tokens}` : "";
    const text = `⏳ ${state.stage} (${elapsed}${tokenStr})`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: Number(state.chatId), message_id: state.messageId, text }),
      });
    } catch {}
  }

  async deleteStatusMessage(chatId: string): Promise<void> {
    const state = this.activeStatus.get(chatId);
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    this.activeStatus.delete(chatId);
    this.lastTokenInfo.delete(chatId);
    this.stopTypingForChat(chatId);

    const token = this.ctx.token();
    if (!token) return;
    try {
      deleteTelegramMessage(token, chatId, state.messageId);
    } catch {}
  }

  startTypingForChat(chatId: string): void {
    if (this.activeTyping.has(chatId)) return;
    const token = this.ctx.token();
    if (!token) return;
    const handle = startTypingRaw(token, chatId);
    this.activeTyping.set(chatId, handle);
    setTimeout(() => this.stopTypingForChat(chatId), this.TYPING_TIMEOUT_MS);
  }

  stopTypingForChat(chatId: string): void {
    const handle = this.activeTyping.get(chatId);
    if (handle) {
      handle.stop();
      this.activeTyping.delete(chatId);
    }
  }

  async startProgressMonitorForChat(chatId: string): Promise<void> {
    this.stopProgressMonitorForChat(chatId);
    const onStatus = (status: string) => {
      const tokenMatch = status.match(/↓\s*([\d.]+[kmKM]?\s*tokens)/i);
      if (tokenMatch) this.lastTokenInfo.set(chatId, tokenMatch[1].trim());
      this.updateStatus(chatId, status);
    };

    let monitor = await startTmuxMonitor(this.ctx.projectName, onStatus);
    if (monitor) {
      this.activeMonitors.set(chatId, monitor);
      channelLogger.info({ project: this.ctx.projectName }, "tmux monitor started");
      return;
    }

    const outputFile = getOutputFilePath(this.ctx.projectName);
    monitor = await startOutputMonitor(outputFile, onStatus);
    if (monitor) {
      this.activeMonitors.set(chatId, monitor);
      channelLogger.info({ outputFile }, "output monitor started");
    }
  }

  stopProgressMonitorForChat(chatId: string): void {
    const monitor = this.activeMonitors.get(chatId);
    if (monitor) {
      monitor.stop();
      this.activeMonitors.delete(chatId);
    }
  }
}

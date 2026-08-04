/**
 * StatusManager — Telegram status messages + typing indicators + progress monitor.
 *
 * Forum mode: when forumChatId() and forumTopicId() are both set, all status
 * messages are sent to that topic instead of the DM chat.
 * The project name prefix is suppressed in forum mode (FR-10) because the
 * topic itself already identifies the project.
 */

import type postgres from "postgres";
import { startTypingRaw, type TypingHandle } from "../utils/typing.ts";
import { startTmuxMonitor, type TmuxMonitorHandle } from "../utils/tmux-monitor.ts";
import { startOutputMonitor, getOutputFilePath, type OutputMonitorHandle } from "../utils/output-monitor.ts";
import { startTranscriptMonitor, type TranscriptMonitorHandle } from "../utils/transcript-monitor.ts";
import { editTelegramMessage, deleteTelegramMessage, sendTelegramMessage, pinTelegramMessage, unpinTelegramMessage } from "./telegram.ts";
import { channelLogger } from "../logger.ts";
import {
  parseTokenCount,
  scrapeTokenInfo,
  formatElapsed,
  getSpinnerIcon as spinnerIconAt,
  computeSignature,
  resolvePhase,
  SPINNER_FRAMES,
  PHASE_LABEL,
} from "../utils/status-format.ts";
import { HoldCounter } from "../utils/hold-counter.ts";
import { renderStatus, clampEscaped } from "../utils/status-render.ts";
import { escapeHtml } from "../utils/html.ts";
import { isRequeued, markRequeued } from "../utils/requeue.ts";
import { hasOpenQuestion } from "../services/ask-question.ts";

/** How much of a captured file path the completion notice may carry. */
const FILE_LABEL_CHARS = 80;

export interface StatusContext {
  sql: postgres.Sql;
  sessionId: () => number | null;
  sessionName: () => string;
  projectName: string;
  /**
   * Absolute path of the project directory.
   *
   * Optional because the terminal monitors only ever needed the name, and every
   * existing caller passes one. The transcript monitor needs the path: it finds
   * the session's own record by matching the `cwd` written inside it, and a
   * basename cannot be matched against an absolute path.
   */
  projectPath?: string;
  token: () => string | undefined;
  /** Forum supergroup chat ID. When set together with forumTopicId, status goes to the topic. */
  forumChatId?: () => string | null;
  /** Forum topic (thread) ID for this project session. */
  forumTopicId?: () => number | null;
}

interface StatusState {
  chatId: string;
  threadId?: number;
  messageId: number;
  startedAt: number;
  stage: string;
  paneSnapshot: string | null;
  paneSnapshotAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  dbHeartbeatTimer: ReturnType<typeof setInterval> | null;
  spinnerFrame: number;
  lastUpdateAt: number;
  editInFlight: boolean;
  lastSentSignature: string | null;
  turnToolCount: number;
  turnFileCount: number;
  turnFilePaths: Set<string>;
  lastCountedToolLine: string | null;
  pendingImmediateEdit: boolean;
  nextEditDelay: number | null;
}

interface SessionStats {
  filesEdited: Set<string>;
  linesAdded: number;
  linesRemoved: number;
}


const SPINNER_INTERVAL_ACTIVE_MS = 3_000;   // when monitor has been active recently
const SPINNER_INTERVAL_IDLE_MS   = 15_000;  // when no monitor activity for >IDLE_THRESHOLD_MS
const IDLE_THRESHOLD_MS          = 12_000;  // switch to idle after 12s of silence

interface StatusExtras {
  phaseEmoji?: string;
  toolCount?: number;
  fileCount?: number;
  /** What the operator asked — the second half of the status is about this. */
  question?: string | null;
}

function formatStatusText(stage: string, elapsed: string, tokens: string, paneSnapshot?: string | null, spinnerIcon?: string, extras?: StatusExtras): string {
  // The rendering itself lives in utils/status-render.ts: it is pure, it is the
  // part the operator actually reads, and it was previously reachable only by
  // having a session produce output.
  return renderStatus({
    stage,
    elapsed: `${elapsed}${tokens}`,
    tokens: undefined,
    pane: paneSnapshot,
    spinner: spinnerIcon ?? SPINNER_FRAMES[0],
    phaseEmoji: extras?.phaseEmoji,
    toolCount: extras?.toolCount,
    fileCount: extras?.fileCount,
    question: extras?.question,
  });
}

export class StatusManager {
  private activeStatus = new Map<string, StatusState>();
  /**
   * Permission prompts pending per chat.
   *
   * Counted rather than flagged: two overlapping requests in one chat would
   * otherwise have the second's release clear the first's signal, and the
   * operator would watch 💬 disappear while still blocked.
   */
  private awaitingPermission = new HoldCounter();
  private lastTokenInfo = new Map<string, string>();
  /**
   * What the operator asked, per chat.
   *
   * Shown in the statistics half of the status so the message says what it is
   * working on rather than only how long it has been at it — a status that has
   * been spinning for four minutes means something different depending on the
   * question.
   */
  private currentQuestion = new Map<string, string>();
  private sessionStats = new Map<string, SessionStats>();
  private activeTyping = new Map<string, TypingHandle>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeMonitors = new Map<string, TmuxMonitorHandle | OutputMonitorHandle | TranscriptMonitorHandle>();
  private responseGuards = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly responseGuardRearmCount = new Map<string, number>();
  private readonly postReplyCheckTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Tracks the single "diff" companion message per status session — edited in-place on repeat calls. */
  private diffMessages = new Map<string, number>(); // key → Telegram message_id
  /** Tracks the single response-guard warning message per key — edited in-place on re-arms instead of sending new messages. */
  private guardMessages = new Map<string, { messageId: number; chatId: string; extra: Record<string, unknown> }>();
  /** Last timestamp the tmux monitor reported activity — tracked even without an active status
   *  so schedulePostReplyCheck can detect if Claude is still working after an early reply. */
  private lastMonitorActivity = new Map<string, number>();
  /**
   * Generation counter per state-key for in-flight sendStatusMessage calls.
   * Allows a slow Telegram response that resolves after the 4s deadline to detect
   * that a newer call (or a deleteStatusMessage) has superseded it, and self-delete
   * the orphan Telegram message instead of late-registering it in activeStatus.
   */
  private pendingSendGenerations = new Map<string, number>();
  private readonly TYPING_TIMEOUT_MS = 30_000;
  private readonly RESPONSE_GUARD_MS = 5 * 60_000; // 5 min

  constructor(private ctx: StatusContext) {}

  /**
   * Telegram chat_ids that currently have an open status message — i.e. Claude
   * is mid-turn for them. The poller uses this to defer delivery of the next
   * user message until the current turn finishes, so each user message gets its
   * own status / turn cycle instead of being injected mid-flight.
   *
   * In forum mode the StatusState stores the forum chat_id (not the per-topic
   * key), which already matches what `message_queue.chat_id` holds — the bot
   * always inserts the parent chat_id, regardless of topic.
   */
  getBusyChats(): Set<string> {
    const out = new Set<string>();
    for (const state of this.activeStatus.values()) out.add(state.chatId);
    return out;
  }

  /**
   * Arm a response guard for a chat. Fires after RESPONSE_GUARD_MS of silence
   * (no reply MCP call). On fire, checks actual tmux activity state and sends
   * one of three messages instead of a generic fallback:
   *
   *  - active recently  → re-arm silently (Claude is working, just slow)
   *  - long thinking    → soft note + re-arm (visible activity was seen but stopped)
   *  - stuck / silent   → alert + delete status (no observable activity at all)
   */
  armResponseGuard(chatId: string): void {
    const key = this.stateKey(chatId);
    const existing = this.responseGuards.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => void this.runResponseGuard(chatId), this.RESPONSE_GUARD_MS);

    this.responseGuards.set(key, timer);
  }

  /**
   * What the guard does when it fires.
   *
   * A named method rather than the timer's callback, because five minutes of
   * waiting is not a test: the decision it makes — is this session silent, or
   * is it blocked on the operator? — is the whole point, and it had no way in.
   *
   * `now` is passed in for the same reason the spinner takes it: what this
   * decides is entirely a question about elapsed time, and a caller that cannot
   * say what time it is can only test the branch where no time has passed.
   */
  async runResponseGuard(chatId: string, now: number = Date.now()): Promise<void> {
    {
      const key = this.stateKey(chatId);
      this.responseGuards.delete(key);
      const state = this.activeStatus.get(key);
      if (!state) return; // already responded

      const token = this.ctx.token();
      if (!token) return;
      const forum = this.getForumTarget();
      const effectiveChatId = forum?.chatId ?? chatId;
      const extra = forum?.extra ?? {};

      const silentMs = now - state.lastUpdateAt;
      const silentStr = formatElapsed(silentMs);
      const stageText = state.stage ?? "";
      const lastActivity = this.lastMonitorActivity.get(key) ?? 0;
      const hadRecentMonitorActivity = (now - lastActivity) < this.RESPONSE_GUARD_MS;
      // The `u` flag matters: ⏳ and 🔄 are surrogate pairs, and without it the
      // class matches their halves individually rather than the emoji.
      const looksActive = hadRecentMonitorActivity || /[·●⏳🔄⎿]/u.test(stageText) || /Brewing|Thinking|Running|agents?/i.test(stageText);

      // Case 0: the session is not silent, it is waiting on the operator.
      //
      // A question with buttons blocks the turn until one is pressed, and the
      // guard read that as Claude having gone quiet: it announced "думает уже
      // 5+ мин" underneath the very question it was waiting for, and the
      // operator was told the session was stuck by the thing that was stuck on
      // them. Re-arm silently — the wait is legitimate and the guard should
      // still be watching for after the answer lands.
      const sessionId = this.ctx.sessionId();
      const awaitingAnswer = sessionId !== null &&
        await hasOpenQuestion(this.ctx.sql, sessionId).catch(() => false);
      if (awaitingAnswer) {
        channelLogger.info({ chatId, silentMs }, "response guard: question open, re-arming silently");
        this.armResponseGuard(chatId);
        return;
      }

      // Case 1: tmux was active very recently — Claude is alive, just working slowly.
      // Re-arm silently so the guard keeps watching without alarming the user.
      if (silentMs < 90_000) {
        channelLogger.info({ chatId, silentMs }, "response guard: recent activity, re-arming silently");
        this.armResponseGuard(chatId);
        return;
      }

      // Case 2: last known tmux state looked active but went quiet.
      // Claude is probably in a long thinking or tool phase — not stuck yet.
      // Edit the existing guard message in-place (silent update) to avoid spamming new messages.
      // Cap at 6 re-arms (30 minutes total) to prevent indefinite re-arming.
      //
      // Exception: if newer messages are waiting in the queue for this chat AND it has been
      // more than 10 min, unblock immediately so the user's follow-ups are not deferred for
      // the full 30-min re-arm cycle. This handles the case where Claude replied to a
      // DIFFERENT chat in a multi-chat batch and never cleared this chat's status.
      let hasPendingQueue = false; // hoisted so Case 3 can use it
      if (looksActive) {
        const count = (this.responseGuardRearmCount.get(key) ?? 0) + 1;
        this.responseGuardRearmCount.set(key, count);
        const TEN_MIN_MS = 10 * 60_000;
        // If it's been more than 10 min, check whether newer messages are waiting. If so,
        // unblock immediately instead of waiting for the full 30-min re-arm cycle.
        if (count < 6 && silentMs >= TEN_MIN_MS) {
          const sid = this.ctx.sessionId();
          hasPendingQueue = (sid !== null) && await this.ctx.sql`
            SELECT 1 FROM message_queue
            WHERE session_id = ${sid} AND chat_id = ${chatId} AND delivered = false
            LIMIT 1
          `.then(rows => rows.length > 0).catch(() => false);
          if (hasPendingQueue) {
            channelLogger.warn({ chatId, silentMs, rearmCount: count }, "response guard: pending queue blocked, unblocking chat immediately");
          }
        }
        if (count < 6 && !hasPendingQueue) {
          channelLogger.warn({ chatId, silentMs, stage: stageText, rearmCount: count }, "response guard: long thinking, re-arming");
          const guardText = `⏳ Claude думает уже 5+ мин. Последняя активность: ${silentStr} назад.\n/session — статус сессии`;
          const existing = this.guardMessages.get(key);
          if (existing) {
            // editMessageText does NOT accept message_thread_id — pass no extra to avoid 400 error
            const edited = await editTelegramMessage(token, existing.chatId, existing.messageId, guardText);
            if (!edited.ok) {
              channelLogger.warn({ error: edited.errorBody }, "response guard: edit failed, sending fresh message");
              const sent = await sendTelegramMessage(token, effectiveChatId, guardText, extra);
              if (sent.messageId) this.guardMessages.set(key, { messageId: sent.messageId, chatId: effectiveChatId, extra });
              else this.guardMessages.delete(key);
            }
          } else {
            const sent = await sendTelegramMessage(token, effectiveChatId, guardText, extra);
            if (sent.messageId) this.guardMessages.set(key, { messageId: sent.messageId, chatId: effectiveChatId, extra });
          }
          this.armResponseGuard(chatId);
          return;
        }
        // count >= 6 OR pending queue blocked: fall through to Case 3
        if (hasPendingQueue) {
          channelLogger.warn({ chatId, silentMs, stage: stageText, rearmCount: count }, "response guard: unblocking for pending queue");
        } else {
          channelLogger.warn({ chatId, silentMs, stage: stageText, rearmCount: count }, "response guard: rearm cap reached, treating as stuck");
        }
      }

      // Case 3: no recent activity and no active-looking stage — likely stuck, OR
      // the chat had pending queue messages that were blocked for >10 min.
      if (!hasPendingQueue) {
        channelLogger.warn({ chatId, silentMs, stage: stageText }, "response guard: no activity, likely stuck");
      }
      const guardEntry = this.guardMessages.get(key);
      if (guardEntry && token) {
        deleteTelegramMessage(token, guardEntry.chatId, guardEntry.messageId);
        this.guardMessages.delete(key);
      }
      await this.deleteStatusMessage(chatId);
      if (!hasPendingQueue) {
        const requeued = await this.requeueUnansweredQuestion(chatId);
        await sendTelegramMessage(
          token,
          effectiveChatId,
          `🔴 Claude не отвечает и tmux молчит уже ${silentStr} — сессия возможно зависла.\n` +
            (requeued ? "♻️ Вопрос возвращён в очередь — переспрашивать не нужно.\n" : "") +
            `/session — статус сессии`,
          extra,
        );
      }
    }
  }

  /**
   * Put the question back on the queue when the guard gives up on a turn.
   *
   * A message is marked delivered the moment it is handed to Claude Code, so a
   * turn that ends in silence consumes it: the operator got a red alert and
   * their question was simply gone, with nothing to retype it from.
   *
   * The supervisor's unanswered-message loop was the only net under this, and
   * the guard falls through it in the two cases that matter most. That loop
   * only looks back thirty minutes, which a guard that spends its full re-arm
   * budget has already used up; and it only retries the newest question in a
   * chat, so anything the operator types after seeing the alert — "ау?" —
   * buries the question it was meant to rescue. Re-queue here, where the loss
   * is known the instant it happens, and let the loop keep sweeping up what
   * this cannot see (a channel that died along with its session).
   *
   * Only a first loss is retried. A question already carrying the re-queue mark
   * has had its second chance; queueing it again would spin.
   */
  private async requeueUnansweredQuestion(chatId: string): Promise<boolean> {
    const sessionId = this.ctx.sessionId();
    if (sessionId === null) return false;

    try {
      const [queued] = await this.ctx.sql`
        SELECT content, from_user, message_id, created_at
        FROM message_queue
        WHERE session_id = ${sessionId} AND chat_id = ${chatId} AND delivered = true
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const content = String(queued?.content ?? "");
      if (!content || isRequeued(content)) return false;

      // A batch that answered a different chat can leave this one's status
      // open. If a reply did land after the question, nothing was lost.
      const [answered] = await this.ctx.sql`
        SELECT 1 FROM messages
        WHERE session_id = ${sessionId} AND chat_id = ${chatId}
          AND role = 'assistant' AND created_at > ${queued.created_at}
        LIMIT 1
      `;
      if (answered) return false;

      // The Telegram message id rides along so the reply tool can still mark
      // the operator's original message answered once this one is picked up.
      await this.ctx.sql`
        INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id, delivered)
        VALUES (
          ${sessionId},
          ${chatId},
          ${String(queued.from_user ?? "user")},
          ${markRequeued(content, "Re-queued — the previous turn ended without a reply. Process normally.")},
          ${queued.message_id ?? null},
          false
        )
      `;
      channelLogger.warn({ chatId, sessionId }, "response guard: re-queued the unanswered question");
      return true;
    } catch (err) {
      channelLogger.warn({ chatId, sessionId, err }, "response guard: re-queue failed");
      return false;
    }
  }

  private disarmResponseGuard(chatId: string): void {
    const key = this.stateKey(chatId);
    const timer = this.responseGuards.get(key);
    if (timer) {
      clearTimeout(timer);
      this.responseGuards.delete(key);
    }
    this.responseGuardRearmCount.delete(key);
    const guardEntry = this.guardMessages.get(key);
    if (guardEntry) {
      const token = this.ctx.token();
      if (token) deleteTelegramMessage(token, guardEntry.chatId, guardEntry.messageId);
      this.guardMessages.delete(key);
    }
  }

  /**
   * Reset the response guard if it is currently armed.
   * Called on each status update — if Claude is producing tmux activity or
   * explicitly calling update_status, it is alive and the guard should not fire.
   * Guard only fires when there has been no observable activity for RESPONSE_GUARD_MS.
   */
  private resetResponseGuard(chatId: string): void {
    const key = this.stateKey(chatId);
    if (!this.responseGuards.has(key)) return; // not armed — nothing to reset
    this.armResponseGuard(chatId); // rearm with a fresh timeout
  }

  /**
   * Schedule a check N ms after reply() to detect multi-step tasks.
   *
   * When Claude sends an early "Запускаю..." reply and then continues working
   * (runs a subagent, long bash command, etc.), the monitor keeps running but
   * the status message and guard were already torn down by reply().
   *
   * After delayMs, we check lastMonitorActivity: if tmux was active recently
   * → Claude is still working → create a continuation status + re-arm guard.
   * If tmux is silent → Claude truly finished, leave everything cleaned up.
   */
  schedulePostReplyCheck(chatId: string, delayMs = 20_000): void {
    const key = this.stateKey(chatId);
    const repliedAt = Date.now();
    const t = setTimeout(async () => {
      this.postReplyCheckTimers.delete(t);
      // If the user already sent a new message, the poller created a fresh status — skip.
      if (this.activeStatus.has(key)) return;

      // Don't create a continuation status if the user already has messages waiting —
      // the poller will deliver them immediately now that the status is gone.
      const sessionId = this.ctx.sessionId();
      if (sessionId !== null) {
        const pending = await this.ctx.sql`
          SELECT 1 FROM message_queue
          WHERE session_id = ${sessionId} AND chat_id = ${chatId} AND delivered = false
          LIMIT 1
        `.catch(() => []);
        if (pending.length > 0) {
          channelLogger.debug({ chatId }, "post-reply: pending user messages found, skipping continuation status");
          this.stopProgressMonitorForChat(chatId);
          this.lastMonitorActivity.delete(key);
          return;
        }
      }

      // Only count tmux activity that happened AFTER the reply was sent.
      // Activity before reply() is stale — it belongs to the completed turn.
      const lastActivity = this.lastMonitorActivity.get(key) ?? 0;
      const hasPostReplyActivity = lastActivity > repliedAt;

      if (hasPostReplyActivity) {
        channelLogger.info({ chatId, lastActivity, repliedAt }, "post-reply: Claude still active, creating continuation status");
        await this.sendStatusMessage(chatId, "🔄 Working on follow-up...");
        this.armResponseGuard(chatId);
        this.startProgressMonitorForChat(chatId).catch(() => {});
      } else {
        // No tmux activity after reply — Claude truly finished.
        this.stopProgressMonitorForChat(chatId);
        this.lastMonitorActivity.delete(key);
        channelLogger.debug({ chatId }, "post-reply: no post-reply activity, cleanup done");
      }
    }, delayMs);
    this.postReplyCheckTimers.add(t);
  }

  /**
   * Resolve the effective Telegram destination for status messages.
   *
   * In forum mode (forumChatId + forumTopicId both set): returns the forum chat
   * and adds message_thread_id to the extras.
   * In DM mode: returns the passed chatId with no extras.
   */
  private getForumTarget(): { chatId: string; threadId: number; extra: Record<string, unknown> } | null {
    const chatId = this.ctx.forumChatId?.();
    const topicId = this.ctx.forumTopicId?.();
    if (chatId && topicId) {
      return { chatId, threadId: topicId, extra: { message_thread_id: topicId } };
    }
    return null;
  }

  /** Map key for the activeStatus / stats maps. */
  /**
   * Hold or release the "blocked on a permission prompt" signal for a chat.
   *
   * Callers must release what they take, and the only caller does it in a
   * `finally` — the lifetime is a scope, not a list of exit paths. Flow 005's
   * attempt at this failed by enumerating paths and missing several, and a
   * leaked latch is silent: 💬 would stay up forever and the signal would stop
   * being believed.
   */
  holdAwaitingPermission(chatId: string): () => void {
    // The key is resolved once and captured. Recomputing it at release time
    // reads `stateKey` again, and the forum topic it derives from can change
    // while a prompt is pending — the release would then target a key nobody
    // holds, leaving the signal up forever, or a key another prompt holds.
    const key = this.stateKey(chatId);
    const release = this.awaitingPermission.acquire(key);
    void this.renderPhaseChange(key);
    return () => {
      release();
      void this.renderPhaseChange(key);
    };
  }

  /**
   * Redraw the status because the latch changed, not because the stage did.
   *
   * Without this the signal waits for the next timer tick: a prompt answered
   * quickly would never show 💬 at all, and one answered slowly would keep
   * showing it after the answer. The stage is untouched — only the phase it
   * is rendered with has changed.
   */
  /**
   * Edit the status, draining anything that arrives while the edit is in
   * flight.
   *
   * Single-flight: a caller that finds an edit running records that another
   * is wanted and returns, and the running edit repeats before it finishes.
   * Without the loop that record was only drained by the 5s timer, so an
   * update landing during an edit — a monitor poll, or the latch flipping —
   * showed up a tick late. For the stage that is a stale line; for the latch
   * it is the wrong emoji on a session that is or is not blocked.
   */
  private static readonly MAX_DRAIN_PASSES = 4;

  private async editWithDrain(state: StatusState): Promise<void> {
    if (state.editInFlight) {
      state.pendingImmediateEdit = true;
      return;
    }
    state.editInFlight = true;
    try {
      // Bounded, and it yields to the rate-limit backoff. An unbounded loop
      // would keep editing for as long as updates keep arriving, which is
      // exactly when Telegram is most likely to be pushing back — and
      // nextEditDelay, which the timer honours, would never be reached.
      // Whatever is still pending after the cap belongs to the timer, one
      // tick later.
      for (let pass = 0; pass < StatusManager.MAX_DRAIN_PASSES; pass++) {
        state.pendingImmediateEdit = false;
        await this.editStatusMessage(state);
        if (!state.pendingImmediateEdit) break;
        if (state.nextEditDelay) break; // rate-limited — let the timer wait it out
      }
    } finally {
      state.editInFlight = false;
    }
  }

  private async renderPhaseChange(key: string): Promise<void> {
    const state = this.activeStatus.get(key);
    if (!state) return;
    await this.editWithDrain(state);
  }

  private stateKey(chatId: string): string {
    const forum = this.getForumTarget();
    return forum ? `${forum.chatId}:${forum.threadId}` : chatId;
  }

  private async getSessionPrefix(chatId: string): Promise<string> {
    // In forum mode the topic already identifies the project — no prefix needed (FR-10)
    if (this.getForumTarget()) return "";

    const sessionId = this.ctx.sessionId();
    if (!sessionId) return "";
    const activeCheck = await this.ctx.sql`
      SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}
    `;
    const isActive = activeCheck.length === 0 || activeCheck[0].active_session_id === sessionId;
    return isActive ? "" : `📌 ${this.ctx.sessionName()} · `;
  }

  /** Record the request this chat's status is about. */
  setQuestion(chatId: string, question: string | null | undefined): void {
    // The same key everything else in this class uses. In forum mode the state
    // is keyed by chat *and* topic, so storing this under the bare chat id
    // would file it where nothing looks for it.
    const key = this.stateKey(chatId);
    const trimmed = question?.trim();
    if (trimmed) this.currentQuestion.set(key, trimmed);
    else this.currentQuestion.delete(key);
  }

  async sendStatusMessage(chatId: string, stage: string, replyToMsgId?: number): Promise<string | null> {
    const token = this.ctx.token();
    if (!token) {
      channelLogger.warn("sendStatusMessage: no TELEGRAM_BOT_TOKEN");
      return "no TELEGRAM_BOT_TOKEN";
    }

    const forum = this.getForumTarget();
    // If forum is configured but topic ID is unknown, skip status — avoid leaking to General
    if (this.ctx.forumChatId?.() && !forum) {
      return null;
    }
    const effectiveChatId = forum?.chatId ?? chatId;
    const key = this.stateKey(chatId);

    const prefix = await this.getSessionPrefix(chatId);
    const existing = this.activeStatus.get(key);

    if (existing) {
      existing.stage = `${prefix}${stage}`;
      existing.startedAt = Date.now();
      existing.lastUpdateAt = Date.now();
      // Same single-flight drain as every other edit path: a latch edge or a
      // monitor update landing during this edit is applied before it finishes,
      // rather than waiting for the next timer tick.
      await this.editWithDrain(existing);
      return null;
    }

    // Register a generation token before the async Telegram call. If deleteStatusMessage
    // fires (or a newer sendStatusMessage starts) while we await the HTTP response, our
    // generation will be stale — we self-delete the orphan message instead of registering.
    const myGen = (this.pendingSendGenerations.get(key) ?? 0) + 1;
    this.pendingSendGenerations.set(key, myGen);

    try {
      const t0 = Date.now();
      // The question belongs on the first render too. The poller records it
      // before the status is created, so leaving it out here means the message
      // spends its first seconds unable to say what it is working on.
      const initialText = formatStatusText(`${prefix}${stage}`, "0s", "", null, SPINNER_FRAMES[0], {
        question: this.currentQuestion.get(key),
      });
      const extra: Record<string, unknown> = {
        parse_mode: "HTML",
        ...(forum?.extra ?? {}),
        ...(replyToMsgId ? { reply_parameters: { message_id: replyToMsgId } } : {}),
      };
      const result = await sendTelegramMessage(token, effectiveChatId, initialText, extra);
      const tgRtt = Date.now() - t0;
      if (!result.ok) {
        // Guard: only clean up our own entry; a concurrent newer call may have bumped the gen.
        if (this.pendingSendGenerations.get(key) === myGen) {
          this.pendingSendGenerations.delete(key);
        }
        channelLogger.warn({ error: result.errorBody }, "sendStatusMessage failed");
        return `Telegram API error`;
      }

      // Guard: if generation changed since we started, a newer call or deleteStatusMessage
      // superseded us — self-delete the orphan rather than late-registering it.
      if (this.pendingSendGenerations.get(key) !== myGen) {
        channelLogger.warn(
          { chatId, messageId: result.messageId, tgRttMs: tgRtt },
          "sendStatusMessage: late registration — deleting orphan",
        );
        // DO NOT delete pendingSendGenerations[key] — it belongs to the newer caller (or is a
        // stale residual). Deleting would cause the newer caller to see undefined and self-orphan.
        deleteTelegramMessage(token, effectiveChatId, result.messageId!);
        return null;
      }

      const state: StatusState = {
        chatId: effectiveChatId,
        threadId: forum?.threadId,
        messageId: result.messageId!,
        startedAt: Date.now(),
        stage: `${prefix}${stage}`,
        paneSnapshot: null,
        paneSnapshotAt: null,
        timer: null,
        dbHeartbeatTimer: null,
        spinnerFrame: 0,
        lastUpdateAt: Date.now(),
        editInFlight: false,
        lastSentSignature: null,
        turnToolCount: 0,
        turnFileCount: 0,
        turnFilePaths: new Set(),
        lastCountedToolLine: null,
        pendingImmediateEdit: false,
        nextEditDelay: null,
      };
      const scheduleTick = (key: string): void => {
        const state = this.activeStatus.get(key);
        if (!state) return;
        const delay = state.nextEditDelay ?? this.chooseSpinnerInterval(state);
        state.nextEditDelay = null;
        state.timer = setTimeout(async () => {
          if (state.editInFlight) {
            scheduleTick(key);
            return;
          }
          await this.refreshPaneSnapshot(state).catch(() => {});
          // SU-5: same drain as the immediate paths, rather than a second copy
          // of the protocol that absorbed exactly one buffered update.
          await this.editWithDrain(state);
          scheduleTick(key);
        }, delay);
      };
      state.dbHeartbeatTimer = setInterval(() => {
        const staleSec = (Date.now() - state.lastUpdateAt) / 1000;
        if (staleSec < 90) {
          this.heartbeatStatusMessage(key);
        }
        // If staleSec >= 90, don't heartbeat — let supervisor detect the stale row
      }, 30_000);
      this.activeStatus.set(key, state);
      scheduleTick(key);
      this.pendingSendGenerations.delete(key);
      this.persistStatusMessage(key, state).catch(() => {});
      pinTelegramMessage(token, effectiveChatId, state.messageId);
      channelLogger.info({ phase: "status", step: "created", chatId: effectiveChatId, messageId: state.messageId, tgRttMs: tgRtt }, "perf");
      return null;
    } catch (e) {
      // Guard: only clean up our own entry; a concurrent newer call may have bumped the gen.
      if (this.pendingSendGenerations.get(key) === myGen) {
        this.pendingSendGenerations.delete(key);
      }
      channelLogger.error({ err: e }, "sendStatusMessage exception");
      return `Exception: ${e}`;
    }
  }

  private diffKey(chatId: string, extra: Record<string, unknown> = {}): string {
    const threadId = extra.message_thread_id;
    return threadId ? `${chatId}:${threadId}` : chatId;
  }

  /**
   * Send or edit the "diff companion" message for this status session.
   * Only one diff message exists per session — subsequent calls edit it in-place
   * instead of creating new messages. Cleaned up in deleteStatusMessage().
   */
  async updateDiff(chatId: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
    const token = this.ctx.token();
    if (!token) return;
    const key = this.diffKey(chatId, extra);
    const existingId = this.diffMessages.get(key);
    if (existingId) {
      // Edit existing diff message in-place
      const res = await editTelegramMessage(token, this.activeStatus.get(key)?.chatId ?? chatId, existingId, content, { parse_mode: "HTML", ...extra });
      if (!res.ok && !res.errorBody?.includes("message is not modified")) {
        // Message was deleted externally — send a new one
        this.diffMessages.delete(key);
        const effectiveChatId = this.activeStatus.get(key)?.chatId ?? chatId;
        const res2 = await sendTelegramMessage(token, effectiveChatId, content, { parse_mode: "HTML", ...extra });
        if (res2.ok && res2.messageId) {
          this.diffMessages.set(key, res2.messageId);
        }
      }
    } else {
      // Send new companion message
      const effectiveChatId = this.activeStatus.get(key)?.chatId ?? chatId;
      const res = await sendTelegramMessage(token, effectiveChatId, content, { parse_mode: "HTML", ...extra });
      if (res.ok && res.messageId) {
        this.diffMessages.set(key, res.messageId);
      }
    }
  }

  async updateStatus(chatId: string, stage: string): Promise<void> {
    const key = this.stateKey(chatId);
    this.accumulateStats(key, stage);
    this.lastMonitorActivity.set(key, Date.now());
    const state = this.activeStatus.get(key);
    if (!state) {
      // No active status — monitor keeps running (post-reply continuation tracking).
      // Do NOT create a new orphan status message here.
      return;
    }
    this.accumulateTurnActivity(state, stage);  // SU-4
    this.resetResponseGuard(chatId);
    state.lastUpdateAt = Date.now();
    state.stage = stage;

    // Single-flight with a drain: if an edit is already running this records
    // that another is wanted and that edit repeats, rather than the update
    // waiting for the next timer tick.
    await this.editWithDrain(state);
  }

  private accumulateTurnActivity(state: StatusState, stage: string): void {
    // stage is multi-line: spinner line first (oldest), then tool lines below (newer).
    // Use the LAST "● " line — the most recent tool call in the block.
    const lastToolLine = stage.split('\n').filter(l => l.startsWith('●')).at(-1);
    if (!lastToolLine) return;
    // Dedup: skip if this is the same tool line we already counted on the previous poll.
    // The same "● Read: file.ts" line persists across multiple updateStatus() calls while
    // surrounding lines (spinner text, sub-output) change — without this guard it would be
    // double-counted every poll tick.
    if (lastToolLine === state.lastCountedToolLine) return;
    state.lastCountedToolLine = lastToolLine;
    state.turnToolCount++;
    // Extract filename from file-operation lines (e.g. "● Read: src/channel/status.ts")
    const fileMatch = lastToolLine.match(/●\s+(?:Read|Write|Edit|Create):\s*([^\s\n]+\.[a-zA-Z]{1,8})/i);
    if (fileMatch) {
      state.turnFilePaths.add(fileMatch[1]);
      state.turnFileCount = state.turnFilePaths.size;
    }
  }

  private accumulateStats(key: string, stage: string): void {
    let stats = this.sessionStats.get(key);
    if (!stats) {
      stats = { filesEdited: new Set(), linesAdded: 0, linesRemoved: 0 };
      this.sessionStats.set(key, stats);
    }
    // Track file edits from status updates (e.g. "Editing: status.ts" or "● Edit: file.ts")
    const editMatch = stage.match(/(?:Editing|● (?:Edit|Write)):\s*([^\s\n]+)/);
    if (editMatch) stats.filesEdited.add(editMatch[1]);
    // Accumulate line changes from tmux output: "  └ Added N lines, removed N lines"
    const linesMatch = stage.match(/Added (\d+) lines?,\s*removed (\d+) lines?/);
    if (linesMatch) {
      stats.linesAdded += parseInt(linesMatch[1]);
      stats.linesRemoved += parseInt(linesMatch[2]);
    }
    // Also handle "Added N lines" without removed (new file)
    const addedOnly = stage.match(/Added (\d+) lines?(?!.*removed)/);
    if (addedOnly && !linesMatch) stats.linesAdded += parseInt(addedOnly[1]);
  }

  private chooseSpinnerInterval(state: StatusState): number {
    const key = state.threadId
      ? `${state.chatId}:${state.threadId}`
      : state.chatId;
    const lastActivity = this.lastMonitorActivity.get(key) ?? 0;
    return (Date.now() - lastActivity) < IDLE_THRESHOLD_MS
      ? SPINNER_INTERVAL_ACTIVE_MS
      : SPINNER_INTERVAL_IDLE_MS;
  }

  private async editStatusMessage(state: StatusState): Promise<void> {
    const token = this.ctx.token();
    if (!token) return;

    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const key = state.threadId ? `${state.chatId}:${state.threadId}` : state.chatId;
    const tokens = this.lastTokenInfo.get(key);
    const tokenStr = tokens ? ` · ↓ ${tokens}` : "";
    // SU-3: compute phase extras
    const phase = resolvePhase(state.stage, this.awaitingPermission.isHeld(key));
    const extras: StatusExtras = {
      phaseEmoji: phase ? PHASE_LABEL[phase] : undefined,
      toolCount: state.turnToolCount,
      fileCount: state.turnFileCount,
      question: this.currentQuestion.get(key),
    };

    // SU-1: compute signature from CONTENT ONLY, excluding the spinner icon.
    // The spinner icon always changes on each call (spinnerFrame increments below),
    // so including it in the signature would make dedup permanently inert.
    // Signature captures: stage + elapsed + tokens + paneSnapshot + phase + toolCount + fileCount.
    const contentForSig = formatStatusText(state.stage, elapsed, tokenStr, state.paneSnapshot, undefined, extras);
    const sig = computeSignature(contentForSig);
    if (sig === state.lastSentSignature) {
      channelLogger.debug({ messageId: state.messageId }, "editStatusMessage: skipping redundant edit");
      return;
    }

    // Content changed — advance spinner and compose final text with the live icon
    state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length;
    const spinnerIcon = spinnerIconAt(state.spinnerFrame, state.lastUpdateAt, Date.now());
    const text = formatStatusText(state.stage, elapsed, tokenStr, state.paneSnapshot, spinnerIcon, extras);

    const res = await editTelegramMessage(token, state.chatId, state.messageId, text, { parse_mode: "HTML" });
    if (!res.ok && !res.errorBody?.includes("message is not modified")) {
      channelLogger.warn({ error: res.errorBody, messageId: state.messageId }, "editStatusMessage failed");
    }
    if (res.ok) {
      state.lastSentSignature = sig;
    }
    // SU-6: back off if rate-limited
    // "telegramRequest 429 deadline exceeded" is the actual error body produced by telegram.ts
    // when the 60s retry budget is exhausted.
    if (!res.ok && (res.errorBody?.includes("429") || res.errorBody?.includes("deadline exceeded"))) {
      state.nextEditDelay = 30_000;
    }
  }

  private async refreshPaneSnapshot(state: StatusState): Promise<void> {
    const sessionId = this.ctx.sessionId();
    if (!sessionId) return;
    const rows = await this.ctx.sql`
      SELECT pane_snapshot, pane_snapshot_at FROM sessions WHERE id = ${sessionId}
    `.catch(() => []);
    if (!rows[0]) return;
    const { pane_snapshot, pane_snapshot_at } = rows[0] as { pane_snapshot: string | null; pane_snapshot_at: Date | null };
    // Only show snapshot if it's fresh (< 30s old)
    const fresh = pane_snapshot_at && (Date.now() - new Date(pane_snapshot_at).getTime()) < 30_000;
    state.paneSnapshot = fresh ? pane_snapshot : null;
    state.paneSnapshotAt = pane_snapshot_at ? new Date(pane_snapshot_at).getTime() : null;
  }

  async deleteStatusMessage(chatId: string): Promise<void> {
    this.disarmResponseGuard(chatId); // reply received — cancel fallback
    const key = this.stateKey(chatId);
    // The turn is over, so the question it was about is too. Left behind, it
    // would head the next turn's status with the previous turn's request.
    this.currentQuestion.delete(key);

    // Bump generation so any in-flight sendStatusMessage that resolves late will
    // see a mismatch and self-delete its orphan message instead of registering it.
    const currentGen = this.pendingSendGenerations.get(key);
    if (currentGen !== undefined) {
      this.pendingSendGenerations.set(key, currentGen + 1);
      channelLogger.debug({ chatId, prevGen: currentGen }, "deleteStatusMessage: bumped generation (in-flight send or stale residual from prior orphan)");
    }

    const state = this.activeStatus.get(key);
    const tDelete = Date.now();
    if (!state) {
      channelLogger.debug({ phase: "status", step: "delete-no-state", chatId }, "perf");
      return;
    }
    const statusLifeMs = tDelete - state.startedAt;
    channelLogger.info({ phase: "status", step: "deleting", chatId, statusLifeMs, messageId: state.messageId }, "perf");
    if (state.timer) clearTimeout(state.timer);
    if (state.dbHeartbeatTimer) clearInterval(state.dbHeartbeatTimer);
    this.activeStatus.delete(key);
    this.ctx.sql`DELETE FROM active_status_messages WHERE key = ${key}`.catch(() => {});
    this.stopTypingForChat(chatId);

    // Wake the poller immediately — a deferred user message for this chat may
    // be waiting in message_queue, and we want zero perceived gap between the
    // ✅ closing of this status and the catchup status of the next turn.
    const sessionId = this.ctx.sessionId();
    if (sessionId !== null) {
      this.ctx.sql`SELECT pg_notify(${`message_queue_${sessionId}`}, '')`.catch(() => {});
    }

    // Delete the diff companion message if one was sent during this session
    const diffExtra = state.threadId ? { message_thread_id: state.threadId } : {};
    const diffMapKey = this.diffKey(state.chatId, diffExtra);
    const diffMsgId = this.diffMessages.get(diffMapKey);
    if (diffMsgId) {
      this.diffMessages.delete(diffMapKey);
    }

    const token = this.ctx.token();
    if (!token) return;

    if (diffMsgId) {
      deleteTelegramMessage(token, state.chatId, diffMsgId);
    }

    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const tokens = this.lastTokenInfo.get(key);
    const stats = this.sessionStats.get(key);
    this.lastTokenInfo.delete(key);
    this.sessionStats.delete(key);

    const parts: string[] = [`⏱ ${elapsed}`];
    if (stats?.filesEdited.size) {
      // The label is captured from terminal output with `[^\s\n]+`, and this
      // message is sent with parse_mode HTML: an unescaped bracket in it fails
      // the send outright, so the completion notice for the turn simply never
      // arrives and nothing says why.
      const fileStr = stats.filesEdited.size === 1
        ? clampEscaped(escapeHtml([...stats.filesEdited][0]!), FILE_LABEL_CHARS)
        : `${stats.filesEdited.size} files`;
      const diffStr = (stats.linesAdded || stats.linesRemoved)
        ? ` <code>+${stats.linesAdded}/-${stats.linesRemoved}</code>`
        : "";
      parts.push(`📝 ${fileStr}${diffStr}`);
    }
    if (tokens) parts.push(`↓ ${tokens}`);

    const summaryText = `✅ ${parts.join(" · ")}`;
    unpinTelegramMessage(token, state.chatId, state.messageId);
    const editRes = await editTelegramMessage(token, state.chatId, state.messageId, summaryText, { parse_mode: "HTML" });
    if (!editRes.ok) {
      deleteTelegramMessage(token, state.chatId, state.messageId);
    }

    // Record Claude Code token usage to api_request_stats (best-effort, non-blocking)
    if (tokens) {
      this.recordCliUsage(chatId, tokens, Date.now() - state.startedAt).catch(() => {});
    }
  }

  /** INSERT or UPDATE the DB record for an active status message. */
  private async persistStatusMessage(key: string, state: StatusState): Promise<void> {
    const sessionId = this.ctx.sessionId();
    try {
      await this.ctx.sql`
        INSERT INTO active_status_messages
          (key, chat_id, thread_id, message_id, started_at, updated_at, project_name, session_id)
        VALUES
          (${key}, ${state.chatId}, ${state.threadId ?? null}, ${state.messageId},
           NOW(), NOW(), ${this.ctx.projectName}, ${sessionId})
        ON CONFLICT (key) DO UPDATE SET
          message_id = EXCLUDED.message_id,
          started_at = NOW(),
          updated_at = NOW(),
          session_id = EXCLUDED.session_id
      `;
    } catch (err) {
      channelLogger.warn({ err }, "persistStatusMessage: DB error");
    }
  }

  /** Touch updated_at so the recovery watchdog knows this channel is alive. */
  private async heartbeatStatusMessage(key: string): Promise<void> {
    try {
      await this.ctx.sql`
        UPDATE active_status_messages SET updated_at = NOW() WHERE key = ${key}
      `;
    } catch (err) {
      channelLogger.warn({ err }, "heartbeatStatusMessage: DB error");
    }
  }

  startTypingForChat(chatId: string): void {
    const key = this.stateKey(chatId);
    if (this.activeTyping.has(key)) return;
    const token = this.ctx.token();
    if (!token) return;
    const forum = this.getForumTarget();
    const effectiveChatId = forum?.chatId ?? chatId;
    const handle = startTypingRaw(token, effectiveChatId);
    this.activeTyping.set(key, handle);
    const existing = this.typingTimers.get(key);
    if (existing) clearTimeout(existing);
    this.typingTimers.set(key, setTimeout(() => this.stopTypingForChat(chatId), this.TYPING_TIMEOUT_MS));
  }

  stopTypingForChat(chatId: string): void {
    const key = this.stateKey(chatId);
    const t = this.typingTimers.get(key);
    if (t) { clearTimeout(t); this.typingTimers.delete(key); }
    const handle = this.activeTyping.get(key);
    if (handle) {
      handle.stop();
      this.activeTyping.delete(key);
    }
  }

  async startProgressMonitorForChat(chatId: string): Promise<void> {
    this.stopProgressMonitorForChat(chatId);
    const key = this.stateKey(chatId);
    const onStatus = (status: string) => {
      // Capped at the source as well as in the renderer: this is scraped from
      // whatever the terminal drew, and it is kept in a map that outlives the
      // turn.
      const tokenInfo = scrapeTokenInfo(status);
      if (tokenInfo) this.lastTokenInfo.set(key, tokenInfo);
      this.updateStatus(chatId, status);
    };

    // Tried first, and it is the only one of the three that sees everything the
    // session did rather than what its terminal happened to be showing when the
    // poll landed. The two below stay wired for a project with no transcript —
    // nothing mounted at the config root, or a CLI started some other way.
    if (this.ctx.projectPath) {
      const transcript = await startTranscriptMonitor(this.ctx.projectPath, onStatus);
      if (transcript) {
        this.activeMonitors.set(key, transcript);
        channelLogger.info({ projectPath: this.ctx.projectPath }, "transcript monitor started");
        return;
      }
      channelLogger.debug({ projectPath: this.ctx.projectPath }, "no transcript for this project, trying tmux");
    }

    let monitor: TmuxMonitorHandle | OutputMonitorHandle | null =
      await startTmuxMonitor(this.ctx.projectName, onStatus);
    if (monitor) {
      this.activeMonitors.set(key, monitor);
      channelLogger.info({ project: this.ctx.projectName }, "tmux monitor started");
      return;
    }
    channelLogger.debug({ project: this.ctx.projectName }, "tmux monitor not found, trying output file");

    const outputFile = getOutputFilePath(this.ctx.projectName);
    monitor = await startOutputMonitor(outputFile, onStatus);
    if (monitor) {
      this.activeMonitors.set(key, monitor);
      channelLogger.info({ outputFile }, "output monitor started");
    } else {
      channelLogger.debug({ project: this.ctx.projectName, outputFile }, "no monitor available — status will only show elapsed time");
    }
  }

  stopProgressMonitorForChat(chatId: string): void {
    const key = this.stateKey(chatId);
    const monitor = this.activeMonitors.get(key);
    if (monitor) {
      monitor.stop();
      this.activeMonitors.delete(key);
    }
  }

  /** Record CLI session token usage to api_request_stats after each completed response. */
  private async recordCliUsage(chatId: string, tokenStr: string, durationMs: number): Promise<void> {
    const totalTokens = parseTokenCount(tokenStr);
    if (!totalTokens || totalTokens <= 0) return;

    const sessionId = this.ctx.sessionId();
    if (!sessionId || sessionId < 0) return;

    try {
      // Look up the model from session's cli_config; fall back to sonnet default
      const rows = await this.ctx.sql`SELECT cli_config FROM sessions WHERE id = ${sessionId}`;
      const cliConfig = rows[0]?.cli_config ?? {};
      const model: string = cliConfig.model ?? "claude-sonnet-4-20250514";

      await this.ctx.sql`
        INSERT INTO api_request_stats
          (session_id, chat_id, provider, model, operation, duration_ms, status, total_tokens)
        VALUES
          (${sessionId}, ${chatId}, 'anthropic', ${model}, 'cli', ${durationMs}, 'success', ${totalTokens})
      `;
      channelLogger.debug({ sessionId, model, totalTokens, durationMs }, "cli usage recorded");
    } catch (err) {
      channelLogger.warn({ err }, "failed to record cli usage stats");
    }
  }

  destroy(): void {
    for (const t of this.postReplyCheckTimers) clearTimeout(t);
    this.postReplyCheckTimers.clear();
  }
}

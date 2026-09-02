/**
 * Helyx Session Supervisor
 *
 * Monitors all session-related health indicators and performs automatic recovery.
 * Inspired by OpenClaw Gateway: central control plane with retry policy,
 * session health tracking, and multi-agent routing.
 *
 * Runs inside admin-daemon.ts as additional setInterval loops,
 * sharing the existing DB connection and shell utilities.
 *
 * Monitoring loops:
 *  1. Session heartbeat   — active_status_messages.updated_at stale >SESSION_STALE_MS (default 5 min) → alert with buttons, no auto-restart
 *  2. Queue stuck         — message_queue pending >5 min → inline-button alert
 *  3. Voice cleanup       — voice_status_messages >3 min → edit Telegram + delete
 *  4. Status broadcast    — every 5 min (delete old + send new for notification)
 *  5. Idle auto-compact   — sessions idle >IDLE_COMPACT_MIN min with ≥10 msgs → summarize + clear
 *  6. Gemma health analyst — every 10 min, holistic snapshot → Gemma → digest if problems found
 *
 * Alerting: Telegram topic SUPERVISOR_CHAT_ID / SUPERVISOR_TOPIC_ID (from .env).
 *           JOINBOX_TOPIC_ID (optional) — preferred fallback for stuck-message forwarding.
 *           STUCK_QUEUE_FORWARD_MINUTES (default 10) — forward threshold.
 *           If not set, alerts are logged only.
 *
 * LLM diagnosis: geekom-model-1 via Ollama (timeout 10s, non-blocking).
 */

import type postgres from "postgres";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat, open } from "node:fs/promises";
import { forceSummarize } from "../memory/summarizer.ts";
import { clearCache } from "../memory/short-term.ts";
import { ErrorWindow } from "../utils/error-stream.ts";
import { getReviewerStatuses, type ReviewerStatus } from "../services/reviewer-service.ts";
import { persistReviewRun, scheduledReviewDecision, type ScheduledReviewState } from "../services/review-artifacts.ts";
import { runReviewers, gitReviewDiff } from "../services/reviewer-service.ts";
import { TranscriptTail, claudeConfigRoot, declaredCwd, MAX_CANDIDATES } from "../utils/transcript-locate.ts";
import {
  decideCrossing,
  newestContextTokens,
  newestOutputTokens,
  newestContextReport,
  contextThreshold,
  resolveWindow,
} from "../utils/context-usage.ts";
import { renderEntry } from "../utils/transcript-events.ts";
import { parseEntry } from "../utils/transcript-locate.ts";
import { isRequeued, markRequeued } from "../utils/requeue.ts";
import { paneLines, hasActiveSpinner, escapeHtml } from "../utils/terminal.ts";
import { stripReasoning } from "../utils/llm-output.ts";
import {
  composeProjectFor,
  listOwnedContainers,
  classifySession,
  providerLabels,
  summarizeQueue,
  hasProblems,
  type ContainerHealth,
  type RunShell,
} from "../utils/supervisor-status.ts";
import { hasOpenQuestion } from "../services/ask-question.ts";
import { sessionFold } from "../services/fold-marker.ts";
import { sessionLimit, limitedSessions, limitLabel, resetLabel, readLimitMarker, limitFromMarker } from "../services/limit-marker.ts";
import { SessionPulse } from "../services/session-pulse.ts";
import {
  sessionProblemKey,
  projectFromSessionProblemKey,
  restartCallbackData,
  paneCallbackData,
  forceDeliverCallbackData,
  ackCallbackData,
  stackUpCallbackData,
} from "../utils/supervisor-callbacks.ts";

// Path to today's tmux session log, for the "see the log" line in alerts.
//
// Derived the same way the writer derives it — tmux-session-logger.ts uses
// resolve(import.meta.dir, "..") — because the two must agree. Both files live
// in scripts/, so the same expression yields the same directory.
//
// This was hardcoded to /home/altsay/bots/helyx until 2026-07-31, which worked
// on exactly one machine and pointed every other installation at a path that
// does not exist.
const BOT_DIR = resolve(import.meta.dir, "..");

/**
 * The compose project whose containers are this supervisor's responsibility.
 *
 * Defaults to the directory compose itself defaults to. Overridable because a
 * second installation on one host would otherwise adopt the first one's
 * containers and report them as its own.
 */
const COMPOSE_PROJECT = composeProjectFor(BOT_DIR, process.env.COMPOSE_PROJECT_NAME);

/** Project names, whose containers are also ours to watch. */
async function knownProjectNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM projects WHERE name IS NOT NULL`
    .catch(() => [] as { name: string }[]);
  return rows.map((r) => r.name).filter(Boolean);
}

function tmuxLogPath(): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  return join(BOT_DIR, "logs", "tmux-sessions", `${dateStr}.jsonl`);
}

// --- Config (read from env, not from CONFIG to avoid circular imports in admin-daemon) ---
const SUPERVISOR_CHAT_ID  = process.env.SUPERVISOR_CHAT_ID  ?? "";
const SUPERVISOR_TOPIC_ID = Number(process.env.SUPERVISOR_TOPIC_ID ?? "0");
const BOT_TOKEN           = process.env.TELEGRAM_BOT_TOKEN  ?? "";
const OLLAMA_URL          = process.env.OLLAMA_URL ?? "http://localhost:11434";
const IDLE_COMPACT_MIN    = Math.max(10, Number(process.env.IDLE_COMPACT_MIN ?? "60") || 60); // minutes before auto-compact
const JOINBOX_TOPIC_ID    = Number(process.env.JOINBOX_TOPIC_ID ?? "0"); // preferred fallback topic for stuck-message forwarding
const STUCK_QUEUE_FORWARD_MINUTES = Math.max(1, Number(process.env.STUCK_QUEUE_FORWARD_MINUTES ?? "10") || 10);

// Thresholds
// Claude Code doing long-running work (git analysis, deep reasoning) can go silent for 3-4 min
// naturally — 2 min was too aggressive and caused constant false-positive restarts.
const SESSION_STALE_MS  = Number(process.env.SESSION_STALE_MS ?? String(5 * 60 * 1000));   // 5 min — heartbeat timeout

// Alert dedup: key → last alerted timestamp
const alertedAt = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 min dedup window

// Acknowledged alerts: key → silenced until ms (refreshed from DB each loop iteration)
const ackedUntil = new Map<string, number>();

// Active alert tracking for recovery edits: key → { messageId, chatId, sentAt, text }
const activeAlerts = new Map<string, { messageId: number; chatId: string; sentAt: number; text?: string }>();
// Recovery clean-since tracking: key → first timestamp when both conditions became clean
const recoveryCleanSince = new Map<string, number>();

async function refreshAcks(sql: postgres.Sql): Promise<void> {
  const rows = await sql`
    SELECT payload FROM admin_commands
    WHERE command = 'supervisor_ack'
      AND created_at > NOW() - INTERVAL '24 hours'
  `.catch(() => [] as any[]);
  ackedUntil.clear();
  for (const row of rows as any[]) {
    const key   = row.payload?.key;
    const until = row.payload?.until_ms;
    if (key && until && until > Date.now()) ackedUntil.set(key, Number(until));
  }
}

// Supervisor start time for uptime tracking
const SUPERVISOR_START = Date.now();
let incidentCount = 0;
let lastIncidentAt: number | null = null;

// --- Telegram helpers ---

/** POST to Telegram API with one 429-retry. Returns parsed JSON or null on error. */
async function tgPost(method: string, body: Record<string, unknown>): Promise<any | null> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  };
  let res = await fetch(url, opts);
  if (res.status === 429) {
    let wait = 6;
    try {
      const data = await res.json() as { parameters?: { retry_after?: number } };
      wait = (data.parameters?.retry_after ?? 5) + 1;
    } catch { /* use default */ }
    console.error(`[supervisor] tgPost ${method} 429 — retrying in ${wait}s`);
    await new Promise(r => setTimeout(r, wait * 1000));
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[supervisor] tgPost ${method} failed: ${res.status} ${errText.slice(0, 150)}`);
    return null;
  }
  return res.json().catch(() => null);
}

async function sendAlert(text: string, topicId?: number): Promise<void> {
  if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) return;

  const body: Record<string, unknown> = {
    chat_id: SUPERVISOR_CHAT_ID,
    text,
    parse_mode: "HTML",
  };
  const tid = topicId ?? (SUPERVISOR_TOPIC_ID > 0 ? SUPERVISOR_TOPIC_ID : undefined);
  if (tid) body.message_thread_id = tid;

  try {
    await tgPost("sendMessage", body);
  } catch {
    // Non-blocking
  }
}

async function editTelegramMsg(chatId: string, messageId: number, text: string, threadId?: number | null): Promise<void> {
  if (!BOT_TOKEN) return;
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (threadId) body.message_thread_id = threadId;
  try {
    await tgPost("editMessageText", body);
  } catch { /* best-effort */ }
}

// --- LLM diagnosis ---

// ORPHANED: nothing calls this. The gemma-health-analyst spec is recorded as
// implemented, but no alert path asks for the explanation, so no incident has
// ever carried one. Kept rather than deleted because the spec still wants it —
// wiring it into sendAlertWithButtons is the open work.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
/** Exported for the tests, which drive it against a stubbed endpoint. */
export async function getLlmExplanation(
  incidentType: string,
  project: string,
  elapsedSec: number,
  actionTaken: string,
  result: string,
): Promise<string> {
  const system = `Ты — компонент мониторинга Telegram-бота Helyx. Твоя единственная задача: кратко объяснить инцидент в 1-2 предложениях на русском языке. Не рассуждай, не задавай вопросы, не выходи за рамки описания инцидента. Отвечай только фактами о произошедшем.`;

  const userMsg = `Инцидент: ${incidentType}
Проект: ${project}
Прошло: ${Math.round(elapsedSec / 60)}m ${elapsedSec % 60}s
Действие: ${actionTaken}
Результат: ${result}

Объясни кратко что произошло и что было сделано.`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OLLAMA_CHAT_MODEL ?? process.env.SUMMARIZE_MODEL ?? "geekom-model-1",
        think: false,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: userMsg },
        ],
        stream: false,
        options: { num_predict: 120, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "";
    const data = await res.json() as { message?: { content?: string } };
    // `think: false` above covers current Ollama; strip as well for versions
    // that ignore it, so a reasoning trace never reaches the incident text.
    return stripReasoning(data.message?.content ?? "");
  } catch {
    return "";
  }
}

// --- Dedup check ---

/**
 * Whether an alert for `key` may be sent right now, recording it if so.
 *
 * Two independent silencers, in order: an acknowledgement the operator set
 * from Telegram ("🔕 Тишина 30м"), and the dedup window that stops one
 * ongoing problem from re-alerting every loop. An ack that has expired is a
 * non-event — it must not keep suppressing — and the dedup window is only
 * armed when an alert actually goes out, so a suppressed check does not push
 * the next one further away.
 *
 * Exported with its state and clock as parameters so the unit tests exercise
 * this implementation rather than a re-implementation that can drift from it;
 * `shouldAlert` below is the production call site with module state bound.
 */
export function shouldAlertNow(
  state: { alertedAt: Map<string, number>; ackedUntil: Map<string, number> },
  key: string,
  now: number,
  dedupWindowMs: number,
): boolean {
  const ackUntil = state.ackedUntil.get(key);
  if (ackUntil && ackUntil > now) return false;
  const last = state.alertedAt.get(key) ?? 0;
  if (now - last < dedupWindowMs) return false;
  state.alertedAt.set(key, now);
  return true;
}

function shouldAlert(key: string): boolean {
  return shouldAlertNow({ alertedAt, ackedUntil }, key, Date.now(), DEDUP_WINDOW_MS);
}

// verifyRecovery lived here: it polled the heartbeat after the supervisor
// restarted a session. The Restart Control Reform removed both auto-restarts,
// so there is no restart left to verify.

// --- Send alert with inline keyboard buttons ---

async function sendAlertWithButtons(
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
): Promise<number | null> {
  if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) {
    console.error("[supervisor] alert (no Telegram):", text.replace(/<[^>]+>/g, ""));
    return null;
  }
  const body: Record<string, unknown> = {
    chat_id: SUPERVISOR_CHAT_ID,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  };
  if (SUPERVISOR_TOPIC_ID) body.message_thread_id = SUPERVISOR_TOPIC_ID;
  const result = await tgPost("sendMessage", body).catch(() => null);
  return result?.result?.message_id ?? null;
}

// --- Log incident to DB ---

async function logIncident(
  sql: postgres.Sql,
  type: string,
  project: string | null,
  sessionId: number | null,
  actionTaken: string,
  result: string,
  llmExplanation: string,
): Promise<void> {
  incidentCount++;
  lastIncidentAt = Date.now();
  try {
    await sql`
      INSERT INTO supervisor_incidents
        (incident_type, project, session_id, action_taken, result, llm_explanation, resolved_at)
      VALUES
        (${type}, ${project}, ${sessionId}, ${actionTaken}, ${result}, ${llmExplanation || null},
         ${result.includes("done") || result.includes("ok") ? sql`NOW()` : null})
    `;
  } catch { /* non-blocking */ }
}

// --- Loop 1: Session heartbeat monitor ---

/**
 * How fresh a pane snapshot has to be to say anything about right now.
 *
 * `scripts/tmux-watchdog.ts` stamps `pane_snapshot_at` on every poll of every
 * active window, so a snapshot older than a couple of minutes means the watchdog
 * is not running rather than that the pane stopped changing. Two minutes covers
 * its poll interval with room and is well under the five minutes this loop calls
 * silence.
 */
const PANE_SNAPSHOT_FRESH_MS = 2 * 60_000;

/**
 * What every active session was doing when it was last looked at.
 *
 * Filled by the context-pressure loop, which already reads each session's
 * transcript every two minutes, and read by two things that would otherwise have
 * to read it again: the pulse below, and the hung-session loop above, which
 * needs an activity signal for the sessions that have no status message to
 * measure. See `services/session-pulse.ts` for why the two obvious columns —
 * `last_active` and `pane_snapshot_at` — are not activity signals at all.
 */
const sessionPulse = new SessionPulse();

/** Exposed so a test can start from nothing; the loops never call it. */
export function resetSessionPulse(): void {
  sessionPulse.reset();
}

/**
 * @param now Taken as a parameter for `runResponseGuard`'s reason: what this
 * decides is entirely a question about elapsed time, and the elapsed times that
 * matter are five minutes long. A test that cannot move the clock can only
 * exercise the branch where nothing has elapsed — which for the pane-driven
 * sessions this loop newly reaches is the branch that says nothing at all.
 */
export async function checkHungSessions(
  sql: postgres.Sql,
  runShell?: RunShell,
  now: number = Date.now(),
): Promise<void> {
  try {
    await refreshAcks(sql);

    // The join used to be inner, and that was a blind spot rather than a filter.
    // `active_status_messages` gets a row in exactly one place — `channel/status.ts`,
    // when the channel sends a Telegram status message for a turn — so a turn
    // typed straight into the tmux pane produces no row, and a session driven
    // that way could not be found hung. Not judged healthy: invisible.
    //
    // Widening it is the dangerous half of this flow, because every active
    // session becomes a candidate and most of them are quiet for ordinary
    // reasons. So the second half of the WHERE is not "no status message and
    // quiet" — it is "no status message and a pane that is currently showing a
    // spinner", and the staleness of those is measured in the loop below from
    // two signals at once: the transcript's own token counts and the pane's
    // text with the spinner taken out of it. A session sitting at an idle
    // prompt is not a candidate at all: it has not been asked to do anything.
    const rows = await sql`
      SELECT
        s.id         AS session_id,
        s.project    AS project,
        s.project_path,
        p.id         AS project_id,
        asm.key,
        asm.started_at,
        asm.updated_at,
        s.pane_snapshot,
        s.pane_snapshot_at
      FROM sessions s
      LEFT JOIN LATERAL (
        SELECT * FROM active_status_messages
        WHERE session_id = s.id
        ORDER BY updated_at DESC
        LIMIT 1
      ) asm ON true
      JOIN projects p ON p.id = s.project_id AND p.tmux_session_name = 'bots'
      WHERE s.status = 'active'
        AND (
          asm.updated_at < NOW() - (${Math.floor(SESSION_STALE_MS / 1000)} * INTERVAL '1 second')
          OR (
            asm.session_id IS NULL
            AND s.pane_snapshot_at > NOW() - (${Math.floor(PANE_SNAPSHOT_FRESH_MS / 1000)} * INTERVAL '1 second')
          )
        )
    `;

    for (const row of rows) {
      const project = String(row.project ?? "unknown");
      const sessionId = Number(row.session_id);
      const projectId = Number(row.project_id);

      // A session with a status message is judged exactly as it was before this
      // flow: the row's `updated_at` is the clock, and everything below reads it.
      // A session without one reaches here only because its pane shows a
      // spinner, and its clock is the last time it did anything at all — its
      // transcript's numbers moving, or its pane printing something that is not
      // its own spinner. See `SessionPulse.activityAt` for why neither
      // `last_active` nor `pane_snapshot_at` can serve, why "no reading yet"
      // means "say nothing" rather than "stale", and why the token counts alone
      // called a session running `bun test` hung for as long as the test ran.
      let staleSince: number;
      if (row.updated_at) {
        staleSince = new Date(row.updated_at).getTime();
      } else {
        const paneSnapshot = typeof row.pane_snapshot === "string" ? row.pane_snapshot : "";
        if (!hasActiveSpinner(paneSnapshot)) continue;
        const activityAt = sessionPulse.activityAt(sessionId);
        if (activityAt === null) continue;
        staleSince = activityAt;
      }

      // One threshold, applied here as well as in the WHERE above. Redundant
      // against a correct query and deliberately not left to it: the widening
      // turned one condition into two joined by OR, and the failure mode of
      // getting that wrong is an alert reading "молчит 0m 0s" — which teaches
      // the operator that this topic is noise. The row the query should not
      // have returned is dropped here instead.
      if (now - staleSince < SESSION_STALE_MS) continue;
      if (!row.updated_at) {
        console.log(`[supervisor] ${project}: no status message, spinner turning, transcript and pane both silent`);
      }
      // A session that asked the operator something is waiting, not hung. Its
      // status line stops updating either way, and before this the two were
      // indistinguishable: the outage that produced this check showed up as
      // two "session is not responding" alerts and no sign of the question.
      if (await hasOpenQuestion(sql, Number(row.session_id))) {
        console.log(`[supervisor] ${row.project}: waiting on a question, not hung`);
        continue;
      }

      // A session compacting its context is folding, not hung, and the two look
      // identical from here: the status message stops updating for the whole of
      // it. `durationMs` was 119544 and 149137 on the two folds observed in this
      // project on 2026-08-08, so a fold eats between a third and a half of
      // `SESSION_STALE_MS` before it has done anything wrong, and a fold that
      // starts two minutes into a quiet stretch is alerted on.
      //
      // Bounded by `services/fold-marker.ts`: a marker whose fold never finished
      // — a CLI that died mid-compaction — stops being believed after its grace
      // window, so this exemption cannot mute the loop permanently.
      const fold = await sessionFold(sql, sessionId, now);
      if (fold) {
        console.log(`[supervisor] ${row.project}: compacting context for ${Math.round(fold.elapsedMs / 1000)}s, not hung`);
        continue;
      }

      // And a session under an API limit is not hung either — it is not allowed
      // to answer. The two look identical from here and the remedies are
      // opposite: the restart button below cannot help, because the limit is on
      // the account and not on the process, and a restarted session comes back
      // and stops again. `checkLimitedSessions` has already said which limit and
      // when it lifts, once, so this loop's job is to hold its alarm and not to
      // send a second message about the same thing.
      //
      // Bounded by `services/limit-marker.ts`: a marker outlives neither its
      // stated reset time nor `LIMIT_GRACE_DEFAULT_MS`, so this exemption cannot
      // mute the loop indefinitely.
      const limit = await sessionLimit(sql, sessionId, now);
      if (limit) {
        console.log(`[supervisor] ${row.project}: ${limitLabel(limit.kind)} ${resetLabel(limit.resetsAt)}, not hung`);
        continue;
      }

      const elapsedMs = now - staleSince;
      const elapsedSec = Math.round(elapsedMs / 1000);
      const dedupKey = sessionProblemKey(project);

      console.log(`[supervisor] hung session detected: ${project} (stale ${elapsedSec}s)`);

      // Capture tmux pane for context
      let pane: string[] = [];
      let spinnerActive = false;
      if (runShell) {
        const paneRaw = await runShell(`tmux capture-pane -p -t "bots:${project}" 2>/dev/null || true`);
        pane = paneLines(paneRaw.output, 5);
        spinnerActive = hasActiveSpinner(paneRaw.output);
      }

      if (!shouldAlert(dedupKey)) {
        // Already alerted by another loop — edit existing message to add hung-session info
        const existing = activeAlerts.get(dedupKey);
        if (existing?.messageId && existing.text) {
          const additionalInfo = `⚠️ Также: сессия не отвечает — молчит ${Math.round(elapsedSec / 60)}m ${elapsedSec % 60}s`;
          await tgPost("editMessageText", {
            chat_id: SUPERVISOR_CHAT_ID,
            message_id: existing.messageId,
            text: existing.text + "\n\n" + additionalInfo,
            parse_mode: "HTML",
          }).catch(() => {});
        }
        continue;
      }

      const logPath = tmuxLogPath();

      const msgParts = [
        `⚠️ <b>Supervisor: сессия не отвечает</b>`,
        `Проект: <code>${project}</code>  Путь: <code>${row.project_path ?? "?"}</code>`,
        `Молчит: ${Math.round(elapsedSec / 60)}m ${elapsedSec % 60}s назад`,
      ];
      if (spinnerActive) {
        msgParts.push(`⚙️ Claude сейчас работает — возможно, не завис`);
      }
      if (pane.length > 0) {
        msgParts.push(`Пане (последние 5 строк):\n<pre>${escapeHtml(pane.join("\n"))}</pre>`);
      }
      msgParts.push(`📁 Лог: ${logPath}`);
      const msg = msgParts.join("\n");

      const messageId = await sendAlertWithButtons(msg, [
        [
          { text: "📋 Показать лог", callback_data: paneCallbackData(projectId) },
          { text: spinnerActive ? "⚠️ Перезапустить (Claude работает!)" : "🔄 Перезапустить", callback_data: restartCallbackData(projectId) },
        ],
        [
          { text: "🔇 Заглушить на 1 ч", callback_data: ackCallbackData(project, projectId) },
        ],
      ]);
      if (messageId) {
        activeAlerts.set(dedupKey, { messageId, chatId: SUPERVISOR_CHAT_ID, sentAt: Date.now(), text: msg });
      }

      await logIncident(sql, "hung_session", project, sessionId, "alerted_user", "pending", "");
    }
  } catch (err: any) {
    console.error(`[supervisor] checkHungSessions error: ${err?.message}`);
  }
}

// --- Loop 1b: the sessions that are not allowed to answer ---

/**
 * Limit events already alerted on, by session and by the event's own identity.
 *
 * The idempotency problem flow 059 solved with `tailUuid`, arriving from two
 * directions at once: the channel re-reads transcript lines after a re-resolve,
 * and this loop re-reads the marker every sixty seconds for as long as the limit
 * holds — five hours of session limit is three hundred passes over one event.
 * The equivalent key is the transcript entry's `uuid`, which Claude Code writes
 * on every line and which travels inside the marker precisely so that the
 * process doing the alerting can tell one event from the next.
 *
 * `startedAt` is the fallback for an entry that carried no uuid. It is written
 * once, when the channel first sees the error, and the channel does not rewrite
 * a marker for an error it has already acted on — so it is stable for the life
 * of one event, which is all this needs it to be.
 *
 * In process, like every other dedup map in this file. A supervisor restart
 * re-alerts once for each limit still in force, and that is the right side of
 * the trade: the alternative is writing an "alerted" flag back into the marker
 * from the container, which puts a second writer on the one row both watchdogs
 * read to decide whether to stay quiet. One duplicate message after a restart —
 * an event the operator is watching anyway — costs less than that.
 */
const limitAlerted = new Map<number, string>();

/** Exposed so a test can start from nothing; the loop never clears it. */
export function resetLimitAlerts(): void {
  limitAlerted.clear();
}

/**
 * Say which limit a session hit and when it lifts. Once per event.
 *
 * Runs on the hung-session loop's timer rather than one of its own: it asks the
 * same database the same question about the same sessions a beat earlier, and
 * the answer decides whether that loop is about to call a limited session hung.
 *
 * No buttons. Not an oversight — there is nothing to press. A restart cannot
 * lift a limit, and nothing here switches provider, restarts or interrupts the
 * session: the only thing that happens automatically is that the poller stops
 * delivering into a session that cannot answer, and starts again when the
 * marker expires. The message exists so the operator knows they are waiting for
 * a clock rather than for a dead process.
 */
export async function checkLimitedSessions(sql: postgres.Sql, now: number = Date.now()): Promise<void> {
  try {
    const limited = await limitedSessions(sql, now);
    const live = new Set<number>();

    for (const session of limited) {
      live.add(session.sessionId);
      const key = session.limit.uuid ?? String(session.limit.startedAt);
      if (limitAlerted.get(session.sessionId) === key) continue;
      limitAlerted.set(session.sessionId, key);

      // What is waiting behind the limit, so the one message about it answers
      // the operator's next question too. One count per event, not per tick:
      // this only runs for a limit that has not been reported yet.
      const [queued] = await sql`
        SELECT COUNT(*)::int AS held FROM message_queue
        WHERE session_id = ${session.sessionId} AND delivered = false
      `.catch(() => [] as { held?: number }[]);
      const held = Number((queued as { held?: number } | undefined)?.held ?? 0);

      const text = [
        `⛔️ <b>Supervisor: сессия под лимитом</b>`,
        `Проект: <code>${escapeHtml(session.project)}</code>`,
        `${limitLabel(session.limit.kind)} — ${resetLabel(session.limit.resetsAt)}`,
        `<i>${escapeHtml(session.limit.text)}</i>`,
        ...(held > 0
          ? [`Сообщений придержано: ${held} — уйдут сами, когда лимит снимется.`]
          : []),
        `Перезапуск не поможет: лимит на аккаунте, а не на процессе.`,
      ].join("\n");

      await sendAlert(text);
      await logIncident(sql, "session_limited", session.project, session.sessionId, "alerted_user", "waiting", "");
      console.log(`[supervisor] ${session.project}: ${limitLabel(session.limit.kind)} ${resetLabel(session.limit.resetsAt)}`);
    }

    // A session whose limit has lifted or whose row is gone is forgotten, so the
    // next limit it hits is a new event rather than a repeat of the last one.
    for (const id of limitAlerted.keys()) if (!live.has(id)) limitAlerted.delete(id);
  } catch (err: any) {
    console.error(`[supervisor] checkLimitedSessions error: ${err?.message}`);
  }
}

// --- Loop 2: Stuck queue monitor ---

export async function checkStuckQueue(sql: postgres.Sql, runShell?: RunShell): Promise<void> {
  try {
    await refreshAcks(sql);

    const rows = await sql`
      SELECT
        mq.session_id,
        p.id AS project_id,
        s.project,
        s.project_path,
        MIN(mq.created_at) AS oldest_pending,
        (SELECT content FROM message_queue WHERE session_id = mq.session_id AND delivered = false ORDER BY created_at LIMIT 1) AS first_msg_content,
        COUNT(*) AS stuck_count
      FROM message_queue mq
      JOIN sessions s ON s.id = mq.session_id
      JOIN projects p ON p.id = s.project_id AND p.tmux_session_name = 'bots'
      WHERE mq.delivered = false
        AND mq.created_at < NOW() - INTERVAL '5 minutes'
      GROUP BY mq.session_id, p.id, s.project, s.project_path
    `;

    for (const row of rows) {
      const project = String(row.project ?? "unknown");
      const sessionId = Number(row.session_id);
      // enqueueRestart takes a project id, not a session id — passing sessionId
      // here made the restart button throw "project <n> not found" every time.
      const projectId = Number(row.project_id);
      const oldestMs = Date.now() - new Date(row.oldest_pending).getTime();
      const oldestSec = Math.round(oldestMs / 1000);
      const stuckCount = Number(row.stuck_count ?? 1);
      const firstMsgContent = String(row.first_msg_content ?? "");
      const dedupKey = sessionProblemKey(project);

      // Held, not stuck. The poller is holding this session's queue on purpose
      // because the account is out of allowance, so the messages are waiting
      // for a clock rather than for a process — and `checkLimitedSessions` has
      // already said so, naming the limit and the time it lifts. Alerting here
      // as well would tell the operator two different stories about one
      // situation, and the wrong one would be the one with a restart button.
      const limit = await sessionLimit(sql, sessionId);
      if (limit) {
        console.log(`[supervisor] ${project}: ${stuckCount} message(s) held for ${limitLabel(limit.kind)} ${resetLabel(limit.resetsAt)}, not stuck`);
        continue;
      }

      console.log(`[supervisor] stuck queue: ${project} (oldest msg ${oldestSec}s, count ${stuckCount})`);

      // Capture tmux pane for context
      let pane: string[] = [];
      let spinnerActive = false;
      if (runShell) {
        const paneRaw = await runShell(`tmux capture-pane -p -t "bots:${project}" 2>/dev/null || true`);
        pane = paneLines(paneRaw.output, 5);
        spinnerActive = hasActiveSpinner(paneRaw.output);
      }

      if (!shouldAlert(dedupKey)) {
        // Already alerted by another loop — edit existing message to add stuck-queue info
        const existing = activeAlerts.get(dedupKey);
        if (existing?.messageId && existing.text) {
          const additionalInfo = `⚠️ Также: очередь застряла — ${stuckCount} сообщений, ${Math.round(oldestSec / 60)}m ${oldestSec % 60}s`;
          await tgPost("editMessageText", {
            chat_id: SUPERVISOR_CHAT_ID,
            message_id: existing.messageId,
            text: existing.text + "\n\n" + additionalInfo,
            parse_mode: "HTML",
          }).catch(() => {});
        }
        continue;
      }

      const logPath = tmuxLogPath();
      const preview = firstMsgContent.slice(0, 120) + (firstMsgContent.length > 120 ? "…" : "");

      const msgParts = [
        `⚠️ <b>Supervisor: очередь застряла</b>`,
        `Проект: <code>${project}</code>`,
        `Сообщений в очереди: ${stuckCount}, ждут: ${Math.round(oldestSec / 60)}m ${oldestSec % 60}s`,
        // Escaped: this is whatever the operator typed, going into a message
        // sent with parse_mode HTML. One "<" and Telegram rejects the whole
        // send — and sendAlertWithButtons swallows the failure, so the alert
        // about a stuck queue would simply never arrive.
        `Первое: <i>${escapeHtml(preview)}</i>`,
      ];
      if (spinnerActive) {
        msgParts.push(`⚙️ Claude сейчас работает — ждёт завершения задачи`);
      }
      // The pane was captured above and, unlike the hung-session alert, never
      // reached the message — the operator lost the one piece of context that
      // says what the session is actually doing.
      if (pane.length > 0) {
        msgParts.push(`Пане (последние 5 строк):\n<pre>${escapeHtml(pane.join("\n"))}</pre>`);
      }
      msgParts.push(`📁 Лог: ${logPath}`);
      const msg = msgParts.join("\n");

      const messageId = await sendAlertWithButtons(msg, [
        [
          { text: "📬 Принудительно доставить", callback_data: forceDeliverCallbackData(sessionId) },
          { text: spinnerActive ? "⚠️ Перезапустить (Claude работает!)" : "🔄 Перезапустить сессию", callback_data: restartCallbackData(projectId) },
        ],
        [
          { text: "🔇 Заглушить на 1 ч", callback_data: ackCallbackData(project, sessionId) },
        ],
      ]);
      if (messageId) {
        activeAlerts.set(dedupKey, { messageId, chatId: SUPERVISOR_CHAT_ID, sentAt: Date.now(), text: msg });
      }

      await logIncident(sql, "stuck_queue", project, sessionId, "alerted_user", "pending", "");
    }

    // Forward messages stuck past STUCK_QUEUE_FORWARD_MINUTES to the fallback channel.
    await forwardStuckMessages(sql);
  } catch (err: any) {
    console.error(`[supervisor] checkStuckQueue error: ${err?.message}`);
  }
}

export async function forwardStuckMessages(sql: postgres.Sql, sessionId?: number): Promise<void> {
  const fallback = resolveFallbackChannel();
  if (!fallback) {
    // Only log if there are actual candidates so we don't spam on every healthy tick.
    return;
  }

  const candidates = sessionId != null
    ? await sql`
        SELECT mq.id, mq.session_id, mq.chat_id, mq.from_user, mq.content,
               s.project,
               EXTRACT(EPOCH FROM (NOW() - mq.created_at))::int AS age_seconds
        FROM message_queue mq
        JOIN sessions s ON s.id = mq.session_id
        JOIN projects p ON p.id = s.project_id AND p.tmux_session_name = 'bots'
        WHERE mq.delivered = false
          AND mq.forwarded_at IS NULL
          AND mq.created_at < NOW() - make_interval(mins => ${STUCK_QUEUE_FORWARD_MINUTES})
          AND mq.session_id = ${sessionId}
      `
    : await sql`
        SELECT mq.id, mq.session_id, mq.chat_id, mq.from_user, mq.content,
               s.project,
               EXTRACT(EPOCH FROM (NOW() - mq.created_at))::int AS age_seconds
        FROM message_queue mq
        JOIN sessions s ON s.id = mq.session_id
        JOIN projects p ON p.id = s.project_id AND p.tmux_session_name = 'bots'
        WHERE mq.delivered = false
          AND mq.forwarded_at IS NULL
          AND mq.created_at < NOW() - make_interval(mins => ${STUCK_QUEUE_FORWARD_MINUTES})
      `;

  if (candidates.length === 0) return;

  // A message held for a limit is not a message nothing managed to deliver, so
  // it does not go out to the fallback channel. Forwarding it would put the
  // operator's own question back in front of them as an undeliverable, ten
  // minutes before the session it is waiting for is allowed to answer it —
  // and `forwarded_at` is set on the way out, so the same message would then
  // never be forwarded again if it did later get stuck for real.
  //
  // Asked once per session rather than once per row: a session with four held
  // messages is one limit.
  const limited = new Set<number>();
  for (const id of new Set(candidates.map((row) => Number(row.session_id)))) {
    if (await sessionLimit(sql, id)) limited.add(id);
  }

  for (const row of candidates) {
    if (limited.has(Number(row.session_id))) continue;
    const ageMin = Math.round(Number(row.age_seconds) / 60);
    const text = [
      `📬 <b>Stuck message forwarded</b>`,
      `Project: <code>${row.project}</code>`,
      `Session: #<code>${row.session_id}</code>`,
      `From: ${row.from_user}`,
      `Queued: ${ageMin}m ago`,
      `———`,
      // The whole message, not a preview — so this is the worst of the three
      // places that put operator text into an HTML-parsed send. Unescaped, one
      // angle bracket loses the forward, which is the last resort for a message
      // nothing else managed to deliver.
      escapeHtml(String(row.content ?? "")),
    ].join("\n");

    const res = await tgPost("sendMessage", {
      chat_id: fallback.chat,
      message_thread_id: fallback.topic,
      text,
      parse_mode: "HTML",
    });
    if (res) {
      await sql`UPDATE message_queue SET forwarded_at = NOW() WHERE id = ${row.id}`;
      console.log(`[supervisor] forwarded stuck message #${row.id} (${row.project}) to fallback channel`);
    }
  }
}

function resolveFallbackChannel(): { chat: string; topic: number } | null {
  if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) return null;
  if (JOINBOX_TOPIC_ID > 0) return { chat: SUPERVISOR_CHAT_ID, topic: JOINBOX_TOPIC_ID };
  if (SUPERVISOR_TOPIC_ID > 0) return { chat: SUPERVISOR_CHAT_ID, topic: SUPERVISOR_TOPIC_ID };
  console.warn("[supervisor] no fallback channel configured, skipping forward");
  return null;
}

// --- Loop 3: Voice status recovery ---

export async function cleanVoiceStatuses(sql: postgres.Sql): Promise<void> {
  try {
    const rows = await sql`
      SELECT id, chat_id, thread_id, message_id
      FROM voice_status_messages
      WHERE created_at < NOW() - INTERVAL '3 minutes'
    `;

    for (const row of rows) {
      await editTelegramMsg(
        String(row.chat_id),
        Number(row.message_id),
        "⚠️ Бот перезапущен — голосовое не обработано. Отправь повторно.",
        row.thread_id ? Number(row.thread_id) : null,
      );
      await sql`DELETE FROM voice_status_messages WHERE id = ${row.id}`;
      console.log(`[supervisor] voice status cleaned: chat ${row.chat_id} msg ${row.message_id}`);
    }
  } catch (err: any) {
    console.error(`[supervisor] cleanVoiceStatuses error: ${err?.message}`);
  }
}

// --- Loop 4: 5-minute full status broadcast ---
//
// The check itself still runs every 5 min (Loop 4's own interval, unchanged) —
// this only throttles how often a result actually reaches Telegram. Before
// this, "healthy" was already silent (an in-place edit, no notification), but
// "problems" posted a fresh delete+send on every single 5-min tick — and once
// `hasProblems()` starts returning true for a real, standing condition (a
// container failing its healthcheck for days, say — see 2026-08-21's
// carlson-bot incident), that is a delete+send every 5 minutes forever, which
// is what actually started 429-throttling the bot in this chat. Healthy now
// posts at most once per HEALTHY_NOTIFY_INTERVAL_MS; problems still post every
// check (PROBLEM_NOTIFY_INTERVAL_MS == the check interval, so no change there)
// — except a problem→healthy transition always posts immediately, so recovery
// isn't hidden behind the healthy interval.
const HEALTHY_NOTIFY_INTERVAL_MS = 20 * 60 * 1000;
const PROBLEM_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;

let statusMessageId: number | null = null; // edit existing message instead of spamming
let lastNotifyAt = 0;
let lastNotifyWasProblem = false;

/**
 * Test-only: resets the throttle clock so the next call is treated as due,
 * without touching `statusMessageId` — that persistence is what
 * supervisor-broadcast.test.ts's "silent when healthy, loud when not" suite
 * is actually testing, and stays in effect across calls exactly as before.
 */
export function resetBroadcastThrottle(): void {
  lastNotifyAt = 0;
  lastNotifyWasProblem = false;
}

export async function sendStatusBroadcast(sql: postgres.Sql, runShell: RunShell): Promise<void> {
  try {
    const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

    // --- Docker status ---
    //
    // The command, the ownership filter and the classification live in
    // `listOwnedContainers`, because the health analyst's snapshot asks the same
    // question and used to ask it differently — `docker ps` without `-a`, which
    // cannot list a container that crashed.
    const scope = { composeProject: COMPOSE_PROJECT, projects: await knownProjectNames(sql) };
    const listing = await listOwnedContainers(runShell, scope);
    const dockerUsable = listing.usable;
    const containers: ContainerHealth[] = listing.containers.map((c) => c.health);
    const dockerLines = listing.containers.map(
      (c) => `${c.health.healthy ? "🟢" : "🔴"} ${c.name} — <i>${escapeHtml(c.status)}</i>`,
    );

    // A readable listing with nothing of ours in it is not health. It means the
    // scope no longer matches reality — an installation in a differently-named
    // directory, or a stack that is entirely gone — and an empty set of owned
    // containers is exactly what a healthy one looks like to `hasProblems`.
    const scopeLost = dockerUsable && containers.length === 0;
    if (scopeLost) {
      dockerLines.push(
        `🔴 ни один контейнер не совпал с <code>${escapeHtml(COMPOSE_PROJECT)}</code> — no containers matched`,
      );
    }

    // --- Session states ---
    const sessions = await sql`
      SELECT
        s.id,
        s.project,
        s.project_path,
        s.status,
        s.last_active,
        asm.updated_at AS asm_updated,
        -- What each session is actually running on. Both nullable, and a null in
        -- either is the default rather than nothing — see providerLabels.
        -- Joined on p.path = s.project_path, the way the context-pressure loop
        -- reaches the same row: the provider picker writes the choice onto the
        -- project, not onto the session.
        pv.name AS provider_name,
        p.model  AS model,
        (
          SELECT COUNT(*) FROM message_queue mq
          WHERE mq.session_id = s.id AND mq.delivered = false
        ) AS pending_msgs
      FROM sessions s
      LEFT JOIN LATERAL (
        SELECT * FROM active_status_messages
        WHERE session_id = s.id
        ORDER BY updated_at DESC
        LIMIT 1
      ) asm ON true
      LEFT JOIN projects p ON p.path = s.project_path
      LEFT JOIN providers pv ON pv.id = p.provider_id
      WHERE s.status = 'active' AND s.id != 0
      ORDER BY s.project
    `;

    const sessionLines: string[] = [];
    for (const row of sessions) {
      const project = String(row.project ?? "?");
      const pendingMsgs = Number(row.pending_msgs ?? 0);
      const asmUpdated = row.asm_updated ? new Date(row.asm_updated) : null;
      const lastActive = row.last_active ? new Date(row.last_active) : null;

      const { icon: stateIcon, text: stateText } = classifySession({
        asmUpdatedMs: asmUpdated?.getTime() ?? null,
        pendingMsgs,
        lastActiveMs: lastActive?.getTime() ?? null,
        now: Date.now(),
      });

      // Provider and model after the state, and short: the list is read at a
      // glance during an incident, so two more fields per line earn their place
      // only as a name and an id, never as a sentence.
      const { provider, model } = providerLabels({
        providerName: row.provider_name as string | null,
        model: row.model as string | null,
      });
      sessionLines.push(
        `${stateIcon} <b>${project}</b> — ${stateText} · <code>${escapeHtml(provider)}/${escapeHtml(model)}</code>`,
      );
    }

    // --- Queue summary ---
    const [qRow] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE delivered = false) AS pending,
        COUNT(*) FILTER (WHERE delivered = false AND created_at < NOW() - INTERVAL '5 minutes') AS stuck
      FROM message_queue
    `;
    const pendingTotal = Number((qRow as any)?.pending ?? 0);
    const stuckTotal = Number((qRow as any)?.stuck ?? 0);

    // --- Supervisor stats ---
    const uptimeMin = Math.floor((Date.now() - SUPERVISOR_START) / 60_000);

    // --- Build message ---
    const lines: string[] = [
      `🖥 <b>Статус системы</b> — ${now}`,
      "",
    ];

    if (dockerLines.length > 0) {
      lines.push("<b>Docker:</b>", ...dockerLines, "");
    } else if (!dockerUsable) {
      lines.push("<b>Docker:</b>", "🔴 не удалось прочитать список контейнеров", "");
    }

    if (sessionLines.length > 0) {
      lines.push(`<b>Сессии (${sessionLines.length}):</b>`, ...sessionLines, "");
    } else {
      lines.push("Активных сессий нет", "");
    }

    const queueStatus = summarizeQueue(pendingTotal, stuckTotal);
    lines.push(`<b>Очередь:</b> ${queueStatus}`);
    lines.push(`<b>Супервизор:</b> 🛡 uptime ${uptimeMin}m · инцидентов: ${incidentCount}`);

    if (stuckTotal > 0) {
      lines.push("", `⚠️ Зависших сообщений: ${stuckTotal}. Нажмите кнопку в алерте для перезапуска.`);
    }

    const text = lines.join("\n");

    if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) {
      console.error("[supervisor] status broadcast (no Telegram):", text.replace(/<[^>]+>/g, ""));
      return;
    }

    // Decided from the classified containers, not from the rendered lines: the
    // choice of icon must not be able to switch alerting off.
    const problems = hasProblems({ containers, stuckTotal, dockerUsable }) || scopeLost;

    // Throttle: post at most once per interval, except a recovery transition
    // (problem -> healthy) always posts immediately regardless of timing.
    const notifyNow = Date.now();
    const isFirstEver = lastNotifyAt === 0;
    const justRecovered = lastNotifyWasProblem && !problems;
    const dueInterval = problems ? PROBLEM_NOTIFY_INTERVAL_MS : HEALTHY_NOTIFY_INTERVAL_MS;
    const isDue = isFirstEver || justRecovered || (notifyNow - lastNotifyAt) >= dueInterval;

    if (!isDue) {
      console.log(
        `[supervisor] status broadcast throttled (${problems ? "problem" : "healthy"}, ` +
        `${Math.round((notifyNow - lastNotifyAt) / 1000)}s since last post, due at ${Math.round(dueInterval / 1000)}s)`,
      );
      return;
    }
    lastNotifyAt = notifyNow;
    lastNotifyWasProblem = problems;

    if (statusMessageId && !problems) {
      // Healthy — edit in-place (silent, no notification)
      const edited = await tgPost("editMessageText", {
        chat_id: SUPERVISOR_CHAT_ID,
        message_id: statusMessageId,
        text,
        parse_mode: "HTML",
      }).catch(() => null);
      if (edited) {
        console.log("[supervisor] status broadcast edited silently (healthy)");
        return;
      }
      // Fall through to send fresh if edit failed (message may have been deleted)
      statusMessageId = null;
    }

    // Problems detected or no existing message — delete old + send new (triggers notification)
    if (statusMessageId) {
      await tgPost("deleteMessage", {
        chat_id: SUPERVISOR_CHAT_ID,
        message_id: statusMessageId,
      }).catch(() => {});
      statusMessageId = null;
    }

    const sendBody: Record<string, unknown> = {
      chat_id: SUPERVISOR_CHAT_ID,
      text,
      parse_mode: "HTML",
    };
    if (SUPERVISOR_TOPIC_ID) sendBody.message_thread_id = SUPERVISOR_TOPIC_ID;
    const sendResult = await tgPost("sendMessage", sendBody);
    if (sendResult?.result?.message_id) {
      statusMessageId = sendResult.result.message_id;
      console.log("[supervisor] status broadcast sent (msg_id:", statusMessageId, problems ? "— problems detected" : "— fresh start", ")");
    }
  } catch (err: any) {
    console.error(`[supervisor] sendStatusBroadcast error: ${err?.message}`);
  }
}

// --- Heartbeat to process_health ---

export async function updateProcessHealth(sql: postgres.Sql): Promise<void> {
  const uptimeMs = Date.now() - SUPERVISOR_START;
  try {
    await sql`
      INSERT INTO process_health (name, status, detail, updated_at)
      VALUES (
        'supervisor',
        'running',
        ${sql.json({ uptime_ms: uptimeMs, incident_count: incidentCount, last_incident_at: lastIncidentAt })},
        NOW()
      )
      ON CONFLICT (name) DO UPDATE
        SET status = 'running', detail = EXCLUDED.detail, updated_at = NOW()
    `;
  } catch { /* non-blocking */ }
}

// --- Context pressure: summarize before Claude Code folds its own context ---

/**
 * How full a window has to be before the session is worth summarising.
 *
 * Not 98%, and the reasons are in `utils/context-usage.ts`: summarising needs
 * room to happen, Claude Code folds ahead of the hard limit so a trigger above
 * that point never fires, and the number lags by a turn.
 */
const CONTEXT_THRESHOLD = contextThreshold(process.env.CONTEXT_SUMMARY_THRESHOLD);

/**
 * How far a session must fall before its high-water mark is released.
 *
 * Releasing exactly at the threshold would let a reading hovering on the line
 * re-arm and re-fire every tick. Ten points is comfortably more than the noise
 * between two reads and comfortably less than what a fold recovers — a compact
 * takes a session from ~0.9 to ~0.2, so it clears this by a wide margin and the
 * next crossing is a real one.
 */
const CONTEXT_HIGH_WATER_HYSTERESIS = 0.1;

/** Highest ratio already summarised, per session. Once per crossing, not per tick. */
const contextHighWater = new Map<number, number>();

/**
 * Windows Claude Code has told us, per session.
 *
 * A window does not change while a session runs, so this is asked once and
 * kept. It is the difference between a percentage and a guess for every
 * provider the table cannot cover — GLM, Kimi, anything arriving through
 * OpenRouter tomorrow.
 */
const contextWindowBySession = new Map<number, number>();

/** Sessions already asked for a window, so a silent `/context` is not retyped every tick. */
const contextAskedAt = new Map<number, number>();

/** How long to wait before asking a session for its window again. */
const CONTEXT_ASK_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Whether the supervisor may type into a session to take the fold for itself.
 *
 * Off by default, and deliberately: this writes into a live pane the operator
 * may be looking at, and `/compact` replaces the session's own context. Both
 * are the right thing at the right moment and an ambush at any other one, so
 * the moment is gated — idle only — and the whole behaviour is opt-in.
 */
export function autoCompactEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.CONTEXT_AUTO_COMPACT ?? "").trim().toLowerCase());
}

/** Reading the tail of a transcript, and summarising — the two things a test cannot do for real. */
export interface ContextPressureDeps {
  /**
   * The newest context measurement for this project, or null when unknown.
   *
   * The optional `candidates` param lets `checkContextPressure` share one
   * transcript-directory scan across every session it checks in a tick
   * instead of each session's read triggering its own full scan (F-001).
   */
  readContext: (projectPath: string, candidates?: TranscriptCandidate[]) => Promise<ContextReading>;
  /** What to run when the threshold is crossed. */
  summarize: (sessionId: number, chatId: string) => Promise<unknown>;
  /**
   * Type into a session's tmux window, or absent to do neither of the two
   * things that need it.
   *
   * This is how `/context` and `/compact` are reached: they are interactive
   * commands, and typing into a pane is how `scripts/tmux-watchdog.ts` already
   * answers permission prompts. Optional because a supervisor without a shell
   * still does the useful half — measuring and summarising.
   */
  sendKeys?: (project: string, keys: string) => Promise<void>;
}

/** What one look at a transcript tail found. */
export interface ContextReading {
  /** Newest `message.usage` total, or null when the transcript has none yet. */
  tokens: number | null;
  /** Window as Claude Code last reported it via `/context`, or null. */
  window: number | null;
  /**
   * Newest completed turn's output, or null.
   *
   * Optional, and it is the pulse that wants it rather than this loop: the
   * decision to summarise is about what went in. Optional rather than required
   * so the existing callers and test doubles that answer the summarising
   * question keep type-checking without having to answer a question they are not
   * being asked.
   */
  outputTokens?: number | null;
  /** The newest line the transcript rendered — what the session is doing. */
  activity?: string | null;
}

/** How much of the transcript's end is read to find the newest usage. */
const CONTEXT_TAIL_BYTES = 256 * 1024;

/** One `.jsonl` transcript found under `<root>/projects`, as `scanTranscriptCandidates` sees it. */
export interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * Every `.jsonl` file one level below `<root>/projects`, newest first.
 *
 * Reimplemented locally rather than calling `resolveTranscript()` (which does
 * this same walk internally on every call, with no sharing across calls).
 * `checkContextPressure` used to call `readSessionContext` — and through it,
 * this scan — once per active session inside its per-session loop, so N
 * sessions in one tick meant N independent full readdir+stat scans of the
 * same transcript tree (F-001). Exported so `checkContextPressure` can run
 * this once per tick and hand the result to every session it checks that
 * tick via `readSessionContext`'s `candidates` parameter.
 */
export async function scanTranscriptCandidates(root: string): Promise<TranscriptCandidate[]> {
  const projectsDir = join(root, "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const out: TranscriptCandidate[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(join(projectsDir, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(projectsDir, dir, file);
      try {
        const info = await stat(path);
        if (info.isFile()) out.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        /* vanished between readdir and stat — a session that just ended */
      }
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The first bytes of a file, enough to hold its first line. */
async function readTranscriptHead(path: string, bytes = 64 * 1024): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Trailing separators removed, so `/a/b` and `/a/b/` are the same directory. */
function normalizeProjectPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The newest transcript belonging to `projectPath` among a pre-scanned
 * candidate listing — the matching half of `resolveTranscript`, split out so
 * the scanning half (`scanTranscriptCandidates`) can be shared across many
 * calls in the same tick instead of repeated per call.
 */
async function matchTranscript(candidates: TranscriptCandidate[], projectPath: string): Promise<string | null> {
  const wanted = normalizeProjectPath(projectPath);
  let examined = 0;
  for (const candidate of candidates) {
    if (examined >= MAX_CANDIDATES) break;
    examined++;
    const cwd = declaredCwd(await readTranscriptHead(candidate.path));
    if (!cwd || normalizeProjectPath(cwd) !== wanted) continue;
    return candidate.path;
  }
  return null;
}

/**
 * The newest context measurement for a project, from its transcript.
 *
 * Separated from the loop because it is the only part that touches a disk, and
 * the loop's decisions are worth testing without one.
 *
 * `candidates`, when given (by `checkContextPressure`, once per tick), skips
 * this call's own directory scan entirely and matches straight against the
 * shared listing (F-001). Omitting it (any other caller) falls back to
 * scanning fresh, so this function's standalone behaviour is unchanged.
 */
export async function readSessionContext(
  projectPath: string,
  candidates?: TranscriptCandidate[],
): Promise<ContextReading> {
  const list = candidates ?? (await scanTranscriptCandidates(claudeConfigRoot()).catch(() => []));
  const path = await matchTranscript(list, projectPath).catch(() => null);
  if (!path) return { tokens: null, window: null };
  const size = await Bun.file(path).size;
  // `near`, not `at`. An arbitrary byte offset is not a record boundary, and
  // `read()` answers a non-boundary by rewinding to zero and returning the
  // whole file — which for these transcripts is tens of megabytes, decoded,
  // split, and `JSON.parse`d line by line, per active session, every tick, in
  // the bot process. `at()` is for an offset a previous read produced.
  const tail = await TranscriptTail.near(path, Math.max(0, size - CONTEXT_TAIL_BYTES));
  const lines = await tail.read().catch(() => [] as string[]);
  // All four come from the same read. The usage total is on every assistant
  // entry; the `/context` report is there only if the command has been run,
  // which is why the window is remembered once found rather than looked up each
  // tick; the output total and the newest rendered line are what the pulse says
  // about a session that is working, and asking for them here is what keeps the
  // pulse from being a second reader of the same file.
  return {
    tokens: newestContextTokens(lines),
    window: newestContextReport(lines)?.window ?? null,
    outputTokens: newestOutputTokens(lines),
    activity: newestActivityLine(lines),
  };
}

/**
 * The newest thing the session did, as one line.
 *
 * `renderEntry` is what the operator already reads in a Telegram status message
 * — `● Bash: bun test`, `● Read: status.ts`, a slice of what the model said — so
 * the pulse says the same thing in the same words rather than inventing a second
 * vocabulary for the same events.
 *
 * Backwards, and stopping at the first entry that renders anything: most lines
 * render nothing at all.
 */
export function newestActivityLine(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const rendered = renderEntry(parseEntry(lines[i]!));
    const last = rendered.at(-1);
    if (last && last.trim()) return last.trim();
  }
  return null;
}

/**
 * Type a command into a session's tmux window.
 *
 * The window name is the project name inside the `bots` session — the same
 * address `checkHungSessions` captures a pane by, and the same mechanism
 * `scripts/tmux-watchdog.ts` uses to answer permission prompts.
 *
 * The name is checked against a strict pattern before it reaches a shell:
 * it arrives from a database column, and everything after it is a command
 * line. The keys are a fixed string at every call site, never operator input.
 */
export async function typeIntoSession(runShell: RunShell, project: string, keys: string): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(project)) throw new Error(`refusing to type into window "${project}"`);
  if (!/^\/[a-z]+$/.test(keys)) throw new Error(`refusing to type "${keys}"`);
  await runShell(`tmux send-keys -t "bots:${project}" "${keys}" Enter`);
}

/** Exposed so a test can reset between cases; the loop itself never clears it. */
export function resetContextHighWater(): void {
  contextHighWater.clear();
  contextWindowBySession.clear();
  contextAskedAt.clear();
}

/**
 * Summarise the sessions that are about to lose the material worth summarising.
 *
 * Idle is read from `active_status_messages`: a row exists for exactly as long
 * as a turn is being reported, so its absence is the session being between
 * turns. A session at the threshold mid-turn is left for the next tick rather
 * than interrupted — the fold is close, not immediate, and cutting into a turn
 * to talk about it would be its own defect.
 */
export async function checkContextPressure(sql: postgres.Sql, deps: ContextPressureDeps): Promise<void> {
  const rows = await sql`
    SELECT
      s.id            AS session_id,
      s.project       AS project,
      s.project_path,
      -- Per project, not per session: /providers sets the model on the
      -- projects row. NULL means whatever Claude defaults to, and the window
      -- table falls back to its documented default for that.
      p.model AS model,
      (asm.chat_id IS NOT NULL) AS busy,
      -- Restored, and worth a comment because of how it went missing: the
      -- pulse's four columns were added *over* this subselect rather than
      -- beside it, so row.chat_id read null for every session and the
      -- if (!chatId) guard below skipped every one of them. The whole loop --
      -- the high-water release, decideCrossing, the /context ask, the summarise
      -- and the fold -- went silent, and silently, because the log line that
      -- would have shown it only prints for sessions that get past the guard.
      --
      -- No fixture catches this: FakeSql matches on a query substring and the
      -- tests hand chat_id back themselves. The test for it reads the SQL text.
      -- (And no backticks in here: this comment lives inside a template
      -- literal, so one would end the string.)
      (SELECT cs.chat_id FROM chat_sessions cs WHERE cs.active_session_id = s.id LIMIT 1) AS chat_id,
      -- The pulse's share of this query. Four more columns on a row already
      -- being fetched, so that saying what a working session is doing costs no
      -- read of its own: when its turn started, whether its pane is showing a
      -- spinner, how fresh that picture is, and whether it is under a limit —
      -- which is a state of its own and not a session that is working.
      asm.started_at AS turn_started_at,
      s.pane_snapshot,
      s.pane_snapshot_at,
      s.metadata
    FROM sessions s
    LEFT JOIN projects p ON p.path = s.project_path
    LEFT JOIN LATERAL (
      SELECT * FROM active_status_messages
      WHERE session_id = s.id
      ORDER BY updated_at DESC
      LIMIT 1
    ) asm ON true
    WHERE s.status = 'active' AND s.id != 0 AND s.project_path IS NOT NULL
  `.catch(() => [] as any[]);

  // Which sessions this tick actually saw, so the per-session maps below can be
  // pruned to them at the end. Nothing else clears them, and a session id is a
  // serial that Postgres reuses after the row is reaped: left alone, every map
  // here grows for the process's lifetime and a new session eventually inherits
  // a stranger's state — in the worst case a high-water mark of 1.0, which would
  // silence its summaries from its first tick.
  const seen = new Set<number>();

  // One scan of the transcript tree for the whole tick, shared by every
  // session's readContext call below, instead of each call re-scanning the
  // same tree independently (F-001).
  const transcriptCandidates = await scanTranscriptCandidates(claudeConfigRoot()).catch(
    () => [] as TranscriptCandidate[],
  );

  for (const row of rows as any[]) {
    const sessionId = Number(row.session_id);
    // The tmux window is named after the project — the same name
    // checkHungSessions captures a pane by.
    const project = String(row.project ?? "");
    const chatId = row.chat_id ? String(row.chat_id) : null;

    const reading = await deps
      .readContext(String(row.project_path), transcriptCandidates)
      .catch(() => ({ tokens: null, window: null }) as ContextReading);

    // A window, once reported, is kept: it does not change while the session
    // runs, and re-reading it every tick would be a lookup for an answer we
    // already have.
    if (reading.window) contextWindowBySession.set(sessionId, reading.window);
    const learnedWindow = contextWindowBySession.get(sessionId) ?? null;

    // Recorded before the chat guard below, deliberately. A session with no
    // chat bound to it is exactly the pane-driven session this flow is trying to
    // make visible — skipping it here would leave the widened hung query with no
    // activity signal for the only sessions it newly reaches, and the pulse
    // blind to the same ones.
    const paneAt = row.pane_snapshot_at ? new Date(row.pane_snapshot_at).getTime() : null;
    const paneFresh = paneAt !== null && Date.now() - paneAt < PANE_SNAPSHOT_FRESH_MS;
    const pane = typeof row.pane_snapshot === "string" ? row.pane_snapshot : null;
    sessionPulse.observe({
      sessionId,
      project,
      inputTokens: reading.tokens,
      outputTokens: reading.outputTokens ?? null,
      window: resolveWindow(learnedWindow, row.model ?? null),
      busy: Boolean(row.busy),
      paneSpinner: paneFresh && hasActiveSpinner(pane ?? ""),
      // The second activity signal, and the reason this column is read for
      // more than its spinner: between an assistant entry carrying a
      // `tool_use` and the user entry carrying its result, the transcript
      // says nothing at all, so a session running `bun test` has frozen token
      // counts for the whole of it while its pane fills with output.
      pane,
      turnStartedAt: row.turn_started_at ? new Date(row.turn_started_at).getTime() : null,
      activity: reading.activity ?? null,
      limited: limitFromMarker(readLimitMarker(row.metadata), Date.now()) !== null,
      at: Date.now(),
    });
    seen.add(sessionId);

    if (!chatId) continue;

    // The mark is released once the session has clearly come back down.
    //
    // Without this it only ever rose, and the name "once per crossing" was
    // wrong: it was once per session. A session summarised at 0.86 folds, drops
    // to 0.2, fills to 0.86 again — and 0.86 is not greater than 0.86, so
    // `already-summarized`, nothing happens. The bar ratchets up a little with
    // every cycle and each one is served later than the last.
    //
    // The terminal case is the one that matters: `usageRatio` clamps at 1, so
    // any session that ever reads full — genuinely, or through a 1M-window
    // model measured against the 200k default — sets the mark to 1.0, after
    // which `ratio <= 1` is true for ever and that session is never summarised
    // again. Silently, and with a log line reading `already-summarized`, which
    // is exactly what a working system prints.
    //
    // Released below threshold minus a margin rather than at the threshold, so
    // a reading hovering on the line does not re-arm and re-fire every tick.
    const priorMark = contextHighWater.get(sessionId) ?? 0;
    const releaseAt = Math.max(0, CONTEXT_THRESHOLD - CONTEXT_HIGH_WATER_HYSTERESIS);
    if (priorMark > 0 && reading.tokens !== null && learnedWindow) {
      if (reading.tokens / learnedWindow < releaseAt) contextHighWater.delete(sessionId);
    }

    const decision = decideCrossing({
      contextTokens: reading.tokens,
      model: row.model ?? null,
      learnedWindow,
      threshold: CONTEXT_THRESHOLD,
      idle: !row.busy,
      highWaterRatio: contextHighWater.get(sessionId) ?? 0,
    });

    // Ask the session what its window is, rather than inferring it from a
    // table that cannot know what GLM or Kimi answer to. Only while idle —
    // typing into a pane mid-turn corrupts whatever is being composed there —
    // and only once in a while, because an unanswered ask must not become a
    // command retyped every tick.
    if (autoCompactEnabled() && deps.sendKeys && !learnedWindow && !row.busy) {
      const askedAt = contextAskedAt.get(sessionId) ?? 0;
      if (Date.now() - askedAt > CONTEXT_ASK_COOLDOWN_MS) {
        contextAskedAt.set(sessionId, Date.now());
        await deps.sendKeys(project, "/context").catch((err: any) =>
          console.error(`[context] session=${sessionId} could not ask for the window: ${err?.message}`),
        );
      }
    }

    // Logged with the window it used. A wrong denominator makes the ratio
    // meaningless, and the only way that is visible rather than silent is if
    // both numbers appear together.
    if (decision.reason !== "no-usage" && decision.reason !== "below-threshold") {
      console.log(
        `[context] session=${sessionId} ratio=${decision.ratio.toFixed(3)} window=${decision.window} ${decision.reason}`,
      );
    }

    if (!decision.summarize) continue;

    // The high-water mark is set *after* a summary exists, and only then.
    //
    // It used to be set on the line above the `try`, which made one bad moment
    // permanent. `decideCrossing` reads `ratio <= highWaterRatio` as
    // "already-summarized", so a session whose summary threw was never retried
    // at that ratio — it had to grow past the mark that had just failed, and a
    // session sitting at 86% of its window may never do that.
    //
    // Worse, `forceSummarize` does not throw when it declines. It returns null
    // on the "low-quality summary output" path, so the old code logged
    // `summarized at 86.0%` for a session where nothing was written to memory
    // at all. That path is not hypothetical: it fired four times for one
    // session on 2026-08-08 while this branch was open.
    //
    // `runIdleCompact` below has checked this return value for null since it
    // was written. This loop is the one that did not.
    let summary: unknown;
    try {
      summary = await deps.summarize(sessionId, chatId);
    } catch (err: any) {
      console.error(`[context] session=${sessionId} summarize failed: ${err?.message}`);
      // The fold is only worth taking once the summary exists. Compacting after
      // a failed summarise would discard exactly the material this whole loop
      // runs to preserve.
      continue;
    }
    if (!summary) {
      // Declined, not failed, and said as such — the operator reading this needs
      // to know the session is still unprotected by *this* layer. The PreCompact
      // hook remains as the later, tighter safety net.
      console.warn(`[context] session=${sessionId} summary declined at ${(decision.ratio * 100).toFixed(1)}% — will retry`);
      continue;
    }
    contextHighWater.set(sessionId, decision.ratio);
    console.log(`[context] session=${sessionId} summarized at ${(decision.ratio * 100).toFixed(1)}%`);

    // Take the fold. Claude Code will do this on its own eventually, and its
    // moment is whenever the window fills — mid-turn, mid-thought, with the
    // operator watching a status message that stops moving. This one happens
    // between turns, immediately after the summary is safely written.
    if (autoCompactEnabled() && deps.sendKeys) {
      try {
        await deps.sendKeys(project, "/compact");
        console.log(`[context] session=${sessionId} compacted at ${(decision.ratio * 100).toFixed(1)}%`);
      } catch (err: any) {
        console.error(`[context] session=${sessionId} compact failed: ${err?.message}`);
      }
    }
  }

  // Forget sessions that are gone. Three maps keyed by session id, none of them
  // ever pruned, in a process that runs for weeks — and the ids are a Postgres
  // serial that gets reused once the old rows are reaped, so a fresh session
  // could start life holding a dead one's high-water mark and never summarise.
  for (const map of [contextHighWater, contextWindowBySession, contextAskedAt]) {
    for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
  }
  // And the fourth, which is keyed the same way and would inherit the same
  // stranger — a reused id carrying a dead session's `changedAt` reads as an
  // hour of silence on a session one minute old.
  sessionPulse.forget(seen);
}

// --- Loop 5c: the pulse ---

/**
 * How often a working session says how it is getting on.
 *
 * Deliberately not the two minutes of the loop that gathers the numbers.
 * Reading a transcript tail is cheap and posting to a Telegram topic is not: at
 * two minutes a single session produces thirty messages an hour, and four
 * sessions produce a hundred and twenty. That is how a monitoring feature
 * becomes noise, then becomes muted, and takes the alarms sitting next to it
 * down with it.
 *
 * Eight minutes is chosen against how long the work takes rather than against
 * how often the data refreshes. The unit of work in this fleet is a flow, which
 * runs for hours; a turn inside one runs for minutes — the two folds measured on
 * 2026-08-08 were two and two and a half minutes of a single compaction. Eight
 * minutes is long enough that a fleet of four costs about thirty lines an hour
 * and short enough that any turn worth watching produces several readings.
 *
 * It also decides how long "stopped progressing" takes to declare, because that
 * verdict needs two consecutive pulses: sixteen minutes of figures that have not
 * moved. That is three times the five minutes at which the hung-session loop
 * calls silence, which is the right relationship — the softer claim should be
 * the slower one, and a pulse that raced the alarm would just be a second alarm.
 *
 * Not five and not ten, so it does not land on the status broadcast's tick or
 * the health analyst's. That is DB-load hygiene rather than a rule, and it is
 * pinned by `supervisor-loops.test.ts`.
 */
export const PULSE_INTERVAL_MS = 8 * 60_000;

/**
 * Post one line per working session, or say nothing at all.
 *
 * Nothing at all is the common case and the important one: a fleet where
 * everything is idle produces no message, and neither does one where the only
 * active sessions have nothing to report yet. A pulse that arrives forever
 * regardless of content is worth less than the silence it replaces.
 */
export async function sendSessionPulse(now: number = Date.now()): Promise<void> {
  const lines = sessionPulse.pulse(now);
  if (lines.length === 0) return;

  const stalled = lines.filter((l) => l.state === "stalled");
  const header = stalled.length === 0
    ? `📈 <b>Пульс</b> — ${lines.length} в работе`
    : `📈 <b>Пульс</b> — ${lines.length} в работе, ${stalled.length} без движения`;

  await sendAlert([header, ...lines.map((l) => l.text)].join("\n"));
}

// --- Idle session auto-compact ---
// This is distinct from the on-disconnect summarization in mcp/server.ts:
// that fires when a Claude Code client drops its MCP connection (threshold: none,
// triggers immediately). This idle-compact fires periodically (every 30 min)
// for sessions that have been silent longer than IDLE_COMPACT_MIN minutes.
// The two can both touch the same session, but since they write summaries
// and then clear messages, the second run simply finds no messages to summarize.

/**
 * Finds active sessions idle > IDLE_COMPACT_MIN minutes with >= 10 messages,
 * summarizes each (session_id, chat_id) pair, saves to long-term memory,
 * and clears the message context so next interaction starts fresh.
 */
export async function checkIdleSessions(sql: postgres.Sql): Promise<void> {
  const idleSessions = await sql`
    SELECT s.id, s.project, s.project_path,
      COUNT(m.id) AS msg_count,
      ARRAY_AGG(DISTINCT m.chat_id::text) AS chat_ids
    FROM sessions s
    JOIN messages m ON m.session_id = s.id
    WHERE s.status = 'active'
      AND s.id != 0
      AND s.last_active < NOW() - (${IDLE_COMPACT_MIN} * INTERVAL '1 minute')
    GROUP BY s.id, s.project, s.project_path
    HAVING COUNT(m.id) >= 10
  `.catch(() => []);

  for (const sess of idleSessions as any[]) {
    const chatIds: string[] = sess.chat_ids ?? [];
    let compacted = 0;

    for (const chatId of chatIds) {
      try {
        const deleteBefore = new Date();
        const result = await forceSummarize(Number(sess.id), chatId, sess.project_path ?? null);
        if (!result) {
          console.warn(`[supervisor] summarize returned null for session, skipping delete`);
          continue;
        }
        clearCache(Number(sess.id), chatId);
        await sql`DELETE FROM messages WHERE session_id = ${sess.id} AND chat_id = ${chatId} AND created_at <= ${deleteBefore}`;
        compacted++;
      } catch (err: any) {
        console.error(`[supervisor] idle compact failed for ${sess.project}/${chatId}: ${err?.message}`);
      }
    }

    if (compacted === 0) continue;

    console.error(`[supervisor] idle compact: ${sess.project} — ${sess.msg_count} msgs, ${compacted} chat(s) cleared`);

    if (BOT_TOKEN && SUPERVISOR_CHAT_ID) {
      const idleMin = Math.round(IDLE_COMPACT_MIN);
      await tgPost("sendMessage", {
        chat_id: SUPERVISOR_CHAT_ID,
        ...(SUPERVISOR_TOPIC_ID ? { message_thread_id: SUPERVISOR_TOPIC_ID } : {}),
        text: `🔄 <b>Авто-сжатие:</b> <b>${sess.project}</b> idle >${idleMin}мин (${sess.msg_count} сообщений).\nКонтекст сохранён в долгосрочную память и очищен.`,
        parse_mode: "HTML",
      }).catch(() => {});
    }
  }
}

// --- Loop 7: Unanswered message detector ---
//
// Detects messages that were pulled from message_queue (delivered=true) and sent
// to Claude Code via MCP notification, but Claude disconnected before replying.
// In that state the message is "gone" — delivered=true so the supervisor's stuck-queue
// check ignores it, but there is no assistant entry in `messages`. This loop finds
// such orphaned user messages and re-injects them so Claude can process them.
//
// Guards against false positives (slow-thinking Claude):
//   1. Min age 5 min  — give Claude enough time before declaring it lost
//   2. Max age 30 min — beyond this the conversation is too stale to re-inject
//   3. ASM freshness  — if active_status_messages for this chat was updated in the
//                       last 2 min, Claude is still working → skip
//   4. No pending     — no delivered=false items in queue for this chat
//   5. Dedup 10 min   — don't re-inject the same session+chat more than once per window

const UNANSWERED_MIN_AGE_MS = 5  * 60 * 1000; // 5 min minimum wait before re-inject
const UNANSWERED_MAX_AGE_MIN = 30;              // 30 min max lookback window
const UNANSWERED_DEDUP_MS    = 10 * 60 * 1000; // 10 min dedup window per session+chat

const unansweredAlertedAt = new Map<string, number>();

export async function checkUnansweredMessages(sql: postgres.Sql): Promise<void> {
  try {
    const rows = await sql`
      SELECT
        s.id          AS session_id,
        s.project,
        m.id          AS msg_id,
        m.chat_id,
        m.content,
        m.created_at,
        EXTRACT(EPOCH FROM (NOW() - m.created_at))::int AS age_sec,
        COALESCE(
          (SELECT mq2.from_user FROM message_queue mq2
           WHERE mq2.session_id = s.id
             AND mq2.chat_id    = m.chat_id
             AND mq2.delivered  = true
           ORDER BY mq2.created_at DESC
           LIMIT 1),
          'user'
        ) AS from_user,
        (SELECT mq3.message_id FROM message_queue mq3
         WHERE mq3.session_id = s.id
           AND mq3.chat_id    = m.chat_id
           AND mq3.delivered  = true
           AND mq3.message_id IS NOT NULL
         ORDER BY mq3.created_at DESC
         LIMIT 1
        ) AS telegram_msg_id
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      WHERE s.status = 'active'
        AND s.id != 0
        AND m.role = 'user'
        -- Time window: old enough to be suspicious, not so old it's pointless
        AND m.created_at < NOW() - (${UNANSWERED_MIN_AGE_MS / 1000} * INTERVAL '1 second')
        AND m.created_at > NOW() - (${UNANSWERED_MAX_AGE_MIN} * INTERVAL '1 minute')
        -- No assistant reply after this user message in the same chat
        AND NOT EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.session_id = s.id
            AND m2.chat_id    = m.chat_id
            AND m2.role       = 'assistant'
            AND m2.created_at > m.created_at
        )
        -- This IS the most recent user message in this chat (no newer one)
        AND NOT EXISTS (
          SELECT 1 FROM messages m3
          WHERE m3.session_id = s.id
            AND m3.chat_id    = m.chat_id
            AND m3.role       = 'user'
            AND m3.created_at > m.created_at
        )
        -- No pending items in queue for this session+chat. A row claimed
        -- more than 2 minutes ago (flow 065's message_queue.claimed_at,
        -- migration v55) and still delivered=false is not "legitimately
        -- in-flight" — the poller never reclaims a claim once taken, so a
        -- process that crashed between claiming and mcp.notification
        -- settling would otherwise sit here as "still pending" forever,
        -- permanently hiding the message from this rescue path too. A
        -- genuine live claim resolves in seconds, well inside 2 minutes.
        -- See docs/report/helyx-telegram-delivery-incident/2026-09-02-
        -- report.md section 10 and flow 065's review findings for T4.
        AND NOT EXISTS (
          SELECT 1 FROM message_queue mq
          WHERE mq.session_id = s.id
            AND mq.chat_id    = m.chat_id
            AND mq.delivered  = false
            AND (mq.claimed_at IS NULL OR mq.claimed_at > NOW() - INTERVAL '2 minutes')
        )
        -- Claude is NOT actively processing this chat (ASM stale > SESSION_STALE_MS)
        AND NOT EXISTS (
          SELECT 1 FROM active_status_messages asm
          WHERE asm.session_id  = s.id
            AND asm.chat_id     = m.chat_id
            AND asm.updated_at  > NOW() - (${Math.floor(SESSION_STALE_MS / 1000)} * INTERVAL '1 second')
        )
    `.catch(() => [] as any[]);

    for (const row of rows as any[]) {
      const project       = String(row.project       ?? "unknown");
      const sessionId     = Number(row.session_id);
      const chatId        = String(row.chat_id);
      const content       = String(row.content       ?? "");
      const fromUser      = String(row.from_user     ?? "user");
      const ageSec        = Number(row.age_sec       ?? 0);
      const telegramMsgId = row.telegram_msg_id ? Number(row.telegram_msg_id) : null;
      const dedupKey      = `unanswered:${sessionId}:${chatId}`;

      console.log(`[supervisor] unanswered message: ${project} chat=${chatId} age=${Math.round(ageSec / 60)}min`);

      const lastAt = unansweredAlertedAt.get(dedupKey) ?? 0;
      if (Date.now() - lastAt < UNANSWERED_DEDUP_MS) {
        console.log(`[supervisor] unanswered deduped: ${dedupKey}`);
        continue;
      }
      unansweredAlertedAt.set(dedupKey, Date.now());

      // 🔥 — set warning reaction on the original Telegram message so user sees it's lost
      if (telegramMsgId && BOT_TOKEN) {
        await tgPost("setMessageReaction", {
          chat_id: chatId,
          message_id: telegramMsgId,
          reaction: [{ type: "emoji", emoji: "🔥" }],
          is_big: false,
        }).catch(() => {});
      }

      // A question the channel's response guard already put back carries the
      // same mark. Retrying it a second time here would just start a loop
      // between the two paths.
      if (isRequeued(content)) {
        console.log(`[supervisor] unanswered already re-queued, leaving alone: ${dedupKey}`);
        continue;
      }

      // Re-inject the lost message back into message_queue
      // Preserve telegram_msg_id so the reply tool can set ✅ when Claude responds
      const reinjectedContent = markRequeued(
        content,
        "Re-injected — previous response was lost during a Claude Code disconnect. Process normally.",
      );
      try {
        // On conflict the existing row is revived rather than inserted twice:
        // `telegram_msg_id` above is read from the original, already-delivered
        // row for this exact (chat_id, message_id), so a plain INSERT here
        // always collides with `idx_queue_msgid_dedup` (memory/db.ts:478-488)
        // and raises a duplicate-key error — silently swallowed by the catch
        // below, so the rescue never actually happened. Same fix, same
        // pattern as channel/status.ts's response guard (lines 748-762),
        // which hit the identical bug.
        //
        // claimed_at = NULL alongside delivered (flow 065 AC8): the row being
        // revived here was originally claimed and delivered, so it still
        // carries the old claim timestamp — the poller's dequeue query now
        // filters on claimed_at IS NULL, so leaving it set would make this
        // "rescued" row invisible to every future claim pass.
        await sql`
          INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id, delivered)
          VALUES (${sessionId}, ${chatId}, ${fromUser}, ${reinjectedContent}, ${telegramMsgId ? String(telegramMsgId) : null}, false)
          ON CONFLICT (chat_id, message_id)
            WHERE message_id IS NOT NULL AND message_id != '' AND message_id != 'tool'
          DO UPDATE
            SET delivered = false, claimed_at = NULL, content = EXCLUDED.content, session_id = EXCLUDED.session_id, from_user = EXCLUDED.from_user
        `;
        console.log(`[supervisor] re-injected lost message for ${project} (chat ${chatId})`);
      } catch (insertErr: any) {
        console.error(`[supervisor] re-inject failed for ${project}: ${insertErr?.message}`);
        continue;
      }

      const ageStr  = `${Math.floor(ageSec / 60)}m ${ageSec % 60}s`;
      const preview = content.slice(0, 120) + (content.length > 120 ? "…" : "");
      await sendAlert([
        `♻️ <b>Supervisor: сообщение переотправлено</b>`,
        `Проект: <code>${project}</code>`,
        `Ждало ответа: ${ageStr}`,
        // Same reason, and worse here: this loop exists to say a message was
        // lost. Unescaped, a message containing "<" makes the send fail
        // silently — the one alert that reports a lost message is the one it
        // cannot deliver. "почему <div> не рендерится" was enough.
        `Сообщение: <i>${escapeHtml(preview)}</i>`,
        `Действие: переинжектировано в очередь`,
      ].join("\n"));
    }
  } catch (err: any) {
    console.error(`[supervisor] checkUnansweredMessages error: ${err?.message}`);
  }
}

// --- Loop 6: Gemma health analyst ---

const GEMMA_HEALTH_DEDUP_MS = 10 * 60 * 1000; // 10 min — same key not re-alerted
const gemmaHealthAlertedAt = new Map<string, number>();

export interface SystemSnapshot {
  activeSessions: { project: string; lastActiveAgo: string }[];
  stuckStatusMessages: { project: string; stuckMin: number }[];
  pendingQueueItems: { project: string; oldestAgo: string }[];
  processHealth: { name: string; status: string }[];
  tmuxSessions: string;
  dockerContainers: string;
}

export async function collectSystemSnapshot(sql: postgres.Sql, runShell: RunShell): Promise<SystemSnapshot> {
  const [sessions, stuckStatus, pendingQueue, processes] = await Promise.all([
    sql`
      SELECT project, last_active,
        EXTRACT(EPOCH FROM (NOW() - last_active))::int AS stale_sec
      FROM sessions
      WHERE status = 'active' AND id != 0
      ORDER BY last_active ASC
      LIMIT 10
    `.catch(() => [] as any[]),

    sql`
      SELECT project_name AS project,
        EXTRACT(EPOCH FROM (NOW() - updated_at))::int / 60 AS stuck_min
      FROM active_status_messages
      WHERE updated_at < NOW() - INTERVAL '5 minutes'
      ORDER BY updated_at ASC
      LIMIT 5
    `.catch(() => [] as any[]),

    sql`
      SELECT s.project,
        MIN(EXTRACT(EPOCH FROM (NOW() - mq.created_at))::int) AS oldest_sec
      FROM message_queue mq
      JOIN sessions s ON s.id = mq.session_id
      WHERE mq.delivered = false
        AND mq.created_at < NOW() - INTERVAL '2 minutes'
      GROUP BY s.project
      LIMIT 5
    `.catch(() => [] as any[]),

    sql`
      SELECT name, status
      FROM process_health
      WHERE updated_at > NOW() - INTERVAL '5 minutes'
      ORDER BY name
    `.catch(() => [] as any[]),
  ]);

  // tmux sessions
  let tmuxSessions = "unavailable";
  try {
    const proc = Bun.spawn(["tmux", "ls"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text().catch(() => "");
    tmuxSessions = out.trim() || "no sessions";
  } catch { /* tmux not available */ }

  // Docker containers — the same listing the broadcast reads, for the same
  // reason. This call site used to run `docker ps` without `-a`, so the analyst
  // was asked to judge health from a list that could not contain a crashed
  // container; and without the ownership filter, from one that could contain
  // somebody else's. An unreadable listing now says so rather than arriving as
  // an absence of containers, which is a different thing entirely.
  let dockerContainers = "unavailable";
  try {
    const listing = await listOwnedContainers(runShell, {
      composeProject: COMPOSE_PROJECT,
      projects: await knownProjectNames(sql),
    });
    if (listing.usable) {
      dockerContainers = listing.containers.length
        ? listing.containers.map((c) => `${c.name}\t${c.status}`).join("\n")
        : "no containers";
    }
  } catch { /* docker not available */ }

  return {
    activeSessions: (sessions as any[]).map((r) => ({
      project: r.project as string,
      lastActiveAgo: `${Math.round(Number(r.stale_sec) / 60)}m ago`,
    })),
    stuckStatusMessages: (stuckStatus as any[]).map((r) => ({
      project: r.project as string,
      stuckMin: Math.round(Number(r.stuck_min)),
    })),
    pendingQueueItems: (pendingQueue as any[]).map((r) => ({
      project: r.project as string,
      oldestAgo: `${Math.round(Number(r.oldest_sec) / 60)}m ago`,
    })),
    processHealth: (processes as any[]).map((r) => ({
      name: r.name as string,
      status: r.status as string,
    })),
    tmuxSessions,
    dockerContainers,
  };
}

export function formatSnapshotForGemma(snap: SystemSnapshot): string {
  const lines: string[] = ["=== Helyx system snapshot ===\n"];

  lines.push(`Active sessions (${snap.activeSessions.length}):`);
  if (snap.activeSessions.length === 0) {
    lines.push("  none");
  } else {
    for (const s of snap.activeSessions) lines.push(`  ${s.project}: last active ${s.lastActiveAgo}`);
  }

  lines.push(`\nStuck status messages (spinner > 5 min):`);
  if (snap.stuckStatusMessages.length === 0) {
    lines.push("  none");
  } else {
    for (const s of snap.stuckStatusMessages) lines.push(`  ${s.project}: stuck ${s.stuckMin} min`);
  }

  lines.push(`\nPending queue items (> 2 min undelivered):`);
  if (snap.pendingQueueItems.length === 0) {
    lines.push("  none");
  } else {
    for (const s of snap.pendingQueueItems) lines.push(`  ${s.project}: oldest ${s.oldestAgo}`);
  }

  lines.push(`\nProcess health:`);
  if (snap.processHealth.length === 0) {
    lines.push("  no data");
  } else {
    for (const p of snap.processHealth) lines.push(`  ${p.name}: ${p.status}`);
  }

  lines.push(`\ntmux sessions:\n  ${snap.tmuxSessions.replace(/\n/g, "\n  ")}`);
  lines.push(`\nDocker containers:\n  ${snap.dockerContainers.replace(/\n/g, "\n  ")}`);

  return lines.join("\n");
}

/**
 * Exported for the tests, which drive it against a stubbed endpoint rather than Ollama.
 *
 * `asked` is the third state, and it was the missing one. Every failure here
 * returns a healthy verdict on purpose — the loop is scheduled with a swallowed
 * catch, and a throw would quietly stop the analyst — but "looked and found
 * nothing" and "never got an answer" were the same value, so an analyst that
 * could not run at all reported the system healthy.
 *
 * Not hypothetical on this host: the check runs every 10 minutes against
 * Ollama's 5-minute keep_alive, so it is normally cold, and a cold load of the
 * model measures 17.2s against this call's 15s ceiling. A short "OK" fits when
 * warm; a digest that actually has something to report does not. So the analyst
 * timed out precisely on the runs where it had found a problem. Raised in review,
 * off the measurements taken for flow #060.
 */
export async function callGemmaForHealth(snapshot: string): Promise<{ ok: boolean; digest: string; asked: boolean }> {
  const model = process.env.SUMMARIZE_MODEL || process.env.OLLAMA_CHAT_MODEL || "geekom-model-1";
  const system = "Ты — аналитик здоровья системы Helyx. Прочитай снапшот состояния. Если всё в норме — ответь только словом OK. Если есть проблемы — кратко опиши их в 2–5 пунктах на русском. Не рассуждай, не задавай вопросы, только факты об обнаруженных проблемах.";

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        think: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: snapshot },
        ],
        stream: false,
        options: { num_predict: 300, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: true, digest: "", asked: false };
    const data = await res.json() as { message?: { content?: string } };
    const text = stripReasoning(data.message?.content ?? "");
    // An empty body is not an answer either: the model was reached but said
    // nothing, which tells us as little as not reaching it.
    if (!text) return { ok: true, digest: "", asked: false };
    if (text.toUpperCase().startsWith("OK")) return { ok: true, digest: "", asked: true };
    return { ok: false, digest: text, asked: true };
  } catch {
    return { ok: true, digest: "", asked: false }; // Ollama unavailable — no verdict
  }
}

/** Exported for the tests, which drive it with fakes rather than Ollama and Telegram. */
export async function checkGemmaHealth(sql: postgres.Sql, runShell: RunShell): Promise<void> {
  const t0 = Date.now();
  let snapshot: SystemSnapshot;
  try {
    snapshot = await collectSystemSnapshot(sql, runShell);
  } catch (err: any) {
    console.error(`[gemma-health] snapshot collection failed: ${err?.message}`);
    return;
  }

  const snapshotText = formatSnapshotForGemma(snapshot);
  const result = await callGemmaForHealth(snapshotText);
  const elapsed = Date.now() - t0;

  // Update process_health regardless of result. "unknown" is not "ok": an
  // analyst that never answered has not cleared the system, and a row that says
  // so is the only way a permanently timing-out check is visible as anything
  // other than health.
  const healthStatus = !result.asked ? "unknown" : result.ok ? "ok" : "degraded";
  sql`
    INSERT INTO process_health (name, status, detail, updated_at)
    VALUES ('gemma-health', ${healthStatus}, ${sql.json({ elapsed_ms: elapsed, asked: result.asked })}, NOW())
    ON CONFLICT (name) DO UPDATE
      SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = NOW()
  `.catch(() => {});

  if (!result.asked) {
    console.warn(`[gemma-health] no verdict — model unreachable or silent (${elapsed}ms)`);
    return;
  }

  if (result.ok) {
    console.log(`[gemma-health] OK (${elapsed}ms)`);
    return;
  }

  console.warn(`[gemma-health] issues detected (${elapsed}ms):\n${result.digest}`);

  // Dedup by digest hash (simple: first 80 chars as key)
  const dedupKey = `gemma-health:${result.digest.slice(0, 80)}`;
  const lastAt = gemmaHealthAlertedAt.get(dedupKey) ?? 0;
  if (Date.now() - lastAt < GEMMA_HEALTH_DEDUP_MS) {
    console.log(`[gemma-health] deduped, skipping Telegram alert`);
    return;
  }
  gemmaHealthAlertedAt.set(dedupKey, Date.now());

  if (!BOT_TOKEN || !SUPERVISOR_CHAT_ID) return;

  await tgPost("sendMessage", {
    chat_id: SUPERVISOR_CHAT_ID,
    ...(SUPERVISOR_TOPIC_ID ? { message_thread_id: SUPERVISOR_TOPIC_ID } : {}),
    text: `🔍 <b>Gemma Health</b>\n\n${result.digest}`,
    parse_mode: "HTML",
  }).catch((err: any) => console.error(`[gemma-health] Telegram post failed: ${err?.message}`));
}

// --- Recovery check ---

export type RecoveryAction = "resolve" | "start-hold" | "keep-waiting" | "reset";

/**
 * What the recovery loop should do with one alert on this tick.
 *
 * An incident is only declared over after it has looked clean twice in a row,
 * `holdMs` apart — a single clean tick can be the gap between two bursts of the
 * same problem, and editing the alert to ✅ then re-alerting seconds later is
 * worse than staying quiet. The timer is cleared the moment a tick is not
 * clean, so recovery has to be continuous rather than cumulative.
 *
 * Exported with its clock as a parameter so the rule can be tested without a
 * database behind it.
 */
export function recoveryDecision(
  bothClear: boolean,
  cleanSince: number | undefined,
  now: number,
  holdMs: number,
): RecoveryAction {
  if (!bothClear) return "reset";
  // A timestamp that is absent, zero, or not a number is no timer at all. The
  // `if (cleanSince && …)` this replaced treated those the same way, and the
  // exported contract should not quietly differ from it.
  if (!cleanSince || !Number.isFinite(cleanSince)) return "start-hold";
  return now - cleanSince >= holdMs ? "resolve" : "keep-waiting";
}

const RECOVERY_HOLD_MS = 60_000;

// --- Loop 9: the bot's own error stream ---

/**
 * The stream this supervisor had never read.
 *
 * Nine checks watch Docker, the queue, the sessions and the status table, and
 * none of them watched what the bot writes about itself. Three separate
 * repeating defects were live in one day of `logs/bot.log` and all three were
 * found by a person reading the file for another reason.
 *
 * Reading is incremental and delegated to `TranscriptTail`, which was written
 * for the status monitor and already handles the two things that go wrong when
 * tailing a file someone else is writing: a line is not a line until its
 * newline arrives, and a file that shrank or changed inode is a different file.
 * A third copy of that reasoning is the last thing this repository needs.
 */
export interface ErrorStreamReader {
  /** Lines appended since the last call. Throws when the file cannot be read. */
  read(): Promise<string[]>;
  window: ErrorWindow;
  /**
   * Consecutive read failures. Kept on the stream rather than in a module
   * variable: the watcher's own health belongs to the thing it is watching, and
   * a counter shared by every caller in the process makes one test's failure
   * the next test's starting condition.
   */
  failures: number;
}

export function createErrorStreamReader(
  path: string = join(BOT_DIR, "logs", "bot.log"),
): ErrorStreamReader {
  let tail: TranscriptTail | null = null;
  const window = new ErrorWindow();
  return {
    window,
    failures: 0,
    async read(): Promise<string[]> {
      // Opened at the end, not the beginning: the file holds weeks of history
      // and replaying it on every daemon restart would alert about errors that
      // stopped long ago.
      //
      // A tail is not opened for a file that is not there yet. Raised in review
      // as "the watcher stays blind for ever"; the mechanism is different and
      // worse. `TranscriptTail.atEnd` does not throw on a missing file — it
      // resolves `stat` to null and starts at offset 0 — so the first read after
      // the file appeared would replay the whole of it. On this host that is
      // 4217 old warnings arriving as though they had just happened.
      if (!tail) {
        if (!existsSync(path)) return [];
        tail = await TranscriptTail.atEnd(path);
      }
      return tail.read();
    },
  };
}

export interface ErrorStreamDeps {
  alert: (text: string, key: string) => Promise<void>;
  note: (message: string) => void;
  now: () => number;
}

/** Consecutive read failures before the watcher reports that it is blind. */
export const ERROR_STREAM_BLIND_AFTER = 2;

export async function checkErrorStream(
  reader: ErrorStreamReader,
  deps: ErrorStreamDeps = {
    alert: async (text, key) => {
      if (!shouldAlert(key)) return;
      await sendAlertWithButtons(text, [
        [{ text: "🔕 Тишина на 1 ч", callback_data: `sup:ack:${key}:0` }],
      ]);
    },
    note: (message) => console.error(`[supervisor] ${message}`),
    now: () => Date.now(),
  },
): Promise<void> {
  let lines: string[];
  try {
    lines = await reader.read();
    reader.failures = 0;
  } catch (err: any) {
    // A monitor that stops running quietly is the defect this loop exists to
    // remove, so its own failure is not allowed to be quiet either.
    reader.failures++;
    deps.note(`error stream unreadable: ${err?.message ?? String(err)}`);
    if (reader.failures === ERROR_STREAM_BLIND_AFTER) {
      await deps.alert(
        "⚠️ <b>Лог бота не читается</b>\nНаблюдение за ошибками не работает — супервизор не видит, что пишет бот.",
        "error_stream:unreadable",
      );
    }
    return;
  }

  for (const alert of reader.window.observe(lines, deps.now())) {
    const minutes = Math.round(alert.windowMs / 60_000);
    const since = new Date(alert.firstAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const heading = alert.reason === "novel" ? "🆕 <b>Новая ошибка в логе бота</b>" : "⚠️ <b>Ошибки в логе бота</b>";
    const body =
      alert.reason === "novel"
        ? `<code>${escapeHtml(alert.msg)}</code>\nвпервые в ${since}`
        : `<code>${escapeHtml(alert.msg)}</code>\n${alert.count} раз за ${minutes} мин · впервые в ${since}`;
    const detail = alert.detail ? `\n<i>${escapeHtml(alert.detail)}</i>` : "";
    await deps.alert(`${heading}\n${body}${detail}`, `error_stream:${alert.msg}`);
  }
}

// --- Loop 10: are the reviewers able to review? ---

/**
 * The reviewers, watched the way everything else here is watched.
 *
 * Availability was answered only when a person opened `/reviewers`, so a dead
 * reviewer announced itself inside the review you had just asked for. On
 * 2026-08-05 Codex refused every run for six days while its login probe kept
 * saying it was logged in, and the operator found out by reading a failed
 * review.
 *
 * Alerts fire on **transitions**, never on state: a reviewer down for six days
 * is one alert, not two hundred and eighty-eight.
 */
export const REVIEWER_BALANCE_FLOOR_USD = 2;
/** Re-arm only above floor + margin, so a balance at the line does not alternate. */
export const REVIEWER_BALANCE_MARGIN_USD = 1;

export interface ReviewerHealthDeps {
  statuses: () => Promise<ReviewerStatus[]>;
  alert: (text: string, key: string) => Promise<void>;
  clear: (text: string, key: string) => Promise<void>;
}

/**
 * Last known state per reviewer id. In memory: a restart re-announces at most
 * once.
 *
 * `downForBalance` is remembered because clearing needs a stronger fact than
 * going down did. Raised in review: a balance endpoint that throws reports
 * `balance check failed`, which contains no number, and treating "no number" as
 * "recovered" announced a recovery on the strength of knowing nothing.
 */
const reviewerWasAvailable = new Map<string, { healthy: boolean; downForBalance: boolean }>();

/** Exported for the tests, which drive transitions rather than a real CLI. */
export function resetReviewerHealthState(): void {
  reviewerWasAvailable.clear();
}

/** A balance below the floor is unavailable even when the endpoint answers. */
export function balanceBelowFloor(detail: string, floor = REVIEWER_BALANCE_FLOOR_USD): boolean {
  const amount = detail.match(/balance \$([0-9]+(?:\.[0-9]+)?)/)?.[1];
  return amount !== undefined && parseFloat(amount) < floor;
}

/**
 * Enough of a balance to clear a balance alert.
 *
 * A missing number is *unknown*, not *resolved*: `balance check failed` is what
 * a thrown probe reports, and it must not read as a recovery.
 */
export function balanceRearmed(detail: string): boolean {
  const amount = detail.match(/balance \$([0-9]+(?:\.[0-9]+)?)/)?.[1];
  if (amount === undefined) return false;
  return parseFloat(amount) >= REVIEWER_BALANCE_FLOOR_USD + REVIEWER_BALANCE_MARGIN_USD;
}

export async function checkReviewerHealth(deps: ReviewerHealthDeps): Promise<void> {
  let statuses: ReviewerStatus[];
  try {
    statuses = await deps.statuses();
  } catch {
    return;
  }

  for (const status of statuses) {
    // An unprobed reviewer is not evidence of anything, in either direction.
    if (!status.probed) continue;

    const lowBalance = balanceBelowFloor(status.detail);
    const healthy = status.available && !lowBalance;
    const previous = reviewerWasAvailable.get(status.id);
    const wasHealthy = previous?.healthy;

    if (wasHealthy === undefined) {
      reviewerWasAvailable.set(status.id, { healthy, downForBalance: lowBalance });
      // First sighting of a reviewer that is already down is worth saying once;
      // one that is up is not news.
      if (!healthy) {
        await deps.alert(
          `🔴 <b>Ревьюер недоступен</b>\n${escapeHtml(status.label)} (${escapeHtml(status.model)}) — ${escapeHtml(status.detail)}`,
          `reviewer_down:${status.id}`,
        );
      }
      continue;
    }

    if (wasHealthy && !healthy) {
      reviewerWasAvailable.set(status.id, { healthy: false, downForBalance: lowBalance });
      await deps.alert(
        `🔴 <b>Ревьюер недоступен</b>\n${escapeHtml(status.label)} (${escapeHtml(status.model)}) — ${escapeHtml(status.detail)}`,
        `reviewer_down:${status.id}`,
      );
      continue;
    }

    // A balance outage needs a fresh number above the floor plus margin to
    // clear; anything else needs only to be healthy again.
    const cleared = healthy && (previous?.downForBalance ? balanceRearmed(status.detail) : true);
    if (!wasHealthy && cleared) {
      reviewerWasAvailable.set(status.id, { healthy: true, downForBalance: false });
      await deps.clear(
        `✅ Ревьюер снова доступен: ${escapeHtml(status.label)} (${escapeHtml(status.model)}) — ${escapeHtml(status.detail)}`,
        `reviewer_down:${status.id}`,
      );
    }
  }
}

/** The real world, for Loop 11. Separated so the loop itself is testable, and exported so this one is too. */
export function scheduledReviewDeps(sql: postgres.Sql, runShell: RunShell): ScheduledReviewDeps {
  return {
    branch: async () => (await runShell("git rev-parse --abbrev-ref HEAD")).output.trim(),
    diff: async () => gitReviewDiff(),
    loadState: async () => {
      const rows = await sql`SELECT value FROM bot_config WHERE key = ${REVIEW_STATE_KEY}`.catch(() => []);
      try {
        return JSON.parse((rows as any[])[0]?.value ?? "{}") as ScheduledReviewState;
      } catch {
        return {};
      }
    },
    saveState: async (state) => {
      await sql`
        INSERT INTO bot_config (key, value) VALUES (${REVIEW_STATE_KEY}, ${JSON.stringify(state)})
        ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(state)}, updated_at = now()
      `.catch(() => {});
    },
    runReview: async (prompt, diff) => {
      const started = Date.now();
      const result = await runReviewers(prompt, async () => diff);
      const branch = (await runShell("git rev-parse --abbrev-ref HEAD")).output.trim();
      const head = (await runShell("git rev-parse HEAD")).output.trim();
      const artifact = await persistReviewRun(result, {
        trigger: "scheduled",
        prompt,
        git: { branch, head, mergeBase: "", diffBytes: Buffer.byteLength(diff, "utf-8") },
        startedAt: started,
        finishedAt: Date.now(),
      });
      const ok = result.reports.filter((r) => r.ok).length;
      return {
        artifactDir: artifact?.dir ?? null,
        summary: `${ok} из ${result.reports.length} ревьюеров ответили`,
      };
    },
    note: (message) => console.error(`[supervisor] ${message}`),
    post: async (text) => { await sendAlert(text); },
  };
}

// --- Loop 11: a review nobody asked for ---

/**
 * The review that starts itself.
 *
 * Nothing did. `scripts/review.ts` ran when a person typed it, and the moment a
 * review is most valuable — a branch that has stopped changing — is exactly the
 * moment attention has moved on.
 *
 * Deliberately not a git hook. `REVIEW_TIMEOUT_MS` is ten minutes; a `pre-push`
 * that can hold a push for that long is disabled within a week, and then
 * nothing runs at all. This observes the work instead of standing in front of
 * it: it writes a file and posts one message, and it cannot block a push, a
 * commit or a container.
 */
export const REVIEW_STATE_KEY = "review_state";

export interface ScheduledReviewDeps {
  branch: () => Promise<string>;
  diff: () => Promise<string>;
  loadState: () => Promise<ScheduledReviewState>;
  saveState: (state: ScheduledReviewState) => Promise<void>;
  /**
   * The diff is handed in rather than read again inside. Raised in review: the
   * loop hashed one snapshot and the runner fetched another, so the hash
   * recorded as reviewed could describe a diff nobody had reviewed.
   */
  runReview: (prompt: string, diff: string) => Promise<{ artifactDir: string | null; summary: string }>;
  note: (message: string) => void;
  post: (text: string) => Promise<void>;
}

/** Stable, cheap, and it only has to detect change. */
export function diffHash(diff: string): string {
  return diff.trim() ? Bun.hash(diff).toString(16) : "";
}

export async function maybeRunScheduledReview(deps: ScheduledReviewDeps): Promise<void> {
  let branch: string;
  let diff: string;
  let hash: string;
  let state: ScheduledReviewState;
  try {
    branch = await deps.branch();
    // One snapshot, hashed and reviewed. Reading it twice was how the recorded
    // hash could end up describing a diff that was never looked at.
    diff = await deps.diff();
    hash = diffHash(diff);
    state = await deps.loadState();
  } catch (err: any) {
    deps.note(`scheduled review: could not read the branch state: ${err?.message ?? String(err)}`);
    return;
  }

  const now = Date.now();
  const decision = scheduledReviewDecision({
    branch,
    defaultBranch: "main",
    diffHash: hash,
    state,
    now,
  });

  if (!decision.run) {
    // The seen-hash is remembered even when the answer is no: that is what
    // makes "the same hash twice" mean "it stopped changing".
    if (state.lastSeenHash !== hash) await deps.saveState({ ...state, lastSeenHash: hash });
    return;
  }

  await deps.saveState({ ...state, lastSeenHash: hash, running: true, runningSince: now });

  let result: { artifactDir: string | null; summary: string };
  try {
    result = await deps.runReview(
      `Scheduled review of branch ${branch}. Report only real defects in the change itself.`,
      diff,
    );
  } catch (err: any) {
    // The flag must not survive a failure, or the loop never runs again. The
    // hash is not recorded as reviewed, because it was not.
    await deps.saveState({ ...state, lastSeenHash: hash, running: false }).catch(() => {});
    deps.note(`scheduled review failed: ${err?.message ?? String(err)}`);
    return;
  }

  // Recorded before the message is sent, and never rolled back by a failure to
  // send it. Raised in review: rolling the state back on a failed post threw
  // away a review that had actually happened, and the same diff was then
  // reviewed again on the next pass.
  await deps.saveState({ lastSeenHash: hash, lastReviewedHash: hash, running: false });

  try {
    await deps.post(
      `🔍 <b>Ревью ветки</b> <code>${escapeHtml(branch)}</code>\n${escapeHtml(result.summary)}` +
        (result.artifactDir ? `\n<code>${escapeHtml(result.artifactDir)}</code>` : ""),
    );
  } catch (err: any) {
    // The review happened and its artifact is on disk; only the announcement
    // failed, and announcing it twice would be worse than not at all.
    deps.note(`scheduled review: could not post the result: ${err?.message ?? String(err)}`);
  }
}

async function checkRecovery(sql: postgres.Sql): Promise<void> {
  for (const [dedupKey, alert] of activeAlerts) {
    const project = projectFromSessionProblemKey(dedupKey);

    // Check hung condition (is ASM heartbeat still stale?)
    const [hungRow] = await sql`
      SELECT 1 FROM sessions s
      JOIN active_status_messages asm ON asm.session_id = s.id
      JOIN projects p ON p.id = s.project_id
      WHERE s.status = 'active' AND p.name = ${project}
        AND asm.updated_at < NOW() - (${Math.floor(SESSION_STALE_MS / 1000)} * INTERVAL '1 second')
    `.catch(() => []);

    // Check stuck condition (are there still undelivered messages older than 5 min?)
    const [stuckRow] = await sql`
      SELECT 1 FROM message_queue mq
      JOIN sessions s ON s.id = mq.session_id
      JOIN projects p ON p.id = s.project_id
      WHERE mq.delivered = false
        AND mq.created_at < NOW() - INTERVAL '5 minutes'
        AND p.name = ${project}
    `.catch(() => []);

    const bothClear = !hungRow && !stuckRow;

    const now = Date.now();
    switch (recoveryDecision(bothClear, recoveryCleanSince.get(dedupKey), now, RECOVERY_HOLD_MS)) {
      case "resolve": {
        const elapsedMin = Math.round((now - alert.sentAt) / 60_000);
        const timeStr = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
        await tgPost("editMessageText", {
          chat_id: alert.chatId,
          message_id: alert.messageId,
          text: `✅ Сессия восстановилась — ждали ${elapsedMin} мин — ${timeStr}`,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        alertedAt.delete(dedupKey);
        activeAlerts.delete(dedupKey);
        recoveryCleanSince.delete(dedupKey);
        break;
      }
      case "start-hold":
        recoveryCleanSince.set(dedupKey, now);
        break;
      case "keep-waiting":
        break;
      case "reset":
        recoveryCleanSince.delete(dedupKey);
        break;
    }
  }
}

// --- Loop 8: is the bot itself alive? ---

/**
 * The one outage nothing was watching.
 *
 * Every other loop here reports a session, a queue or a container into a chat
 * the *bot* delivers. When the bot is the thing that died, all of them go
 * quiet together and the silence reads like calm — which is how a stopped stack
 * went unnoticed until someone tried to use it.
 *
 * This loop can report it because the supervisor is not the bot: it runs inside
 * the host daemon and posts to Telegram over HTTP itself. Its alert therefore
 * arrives during exactly the outage it describes.
 *
 * The button on that alert is a different matter, and the text says so. A
 * callback is delivered *to the bot*, so while the bot is down pressing it does
 * nothing — the way back in during a full outage is `/up` to the host door in
 * `scripts/host-ingress.ts`. The button is for the case this loop also catches:
 * the bot process wedged while its container still runs.
 */
export const BOT_DOWN_KEY = "bot_down";
/** Consecutive failed probes before it is an outage rather than a restart. */
export const BOT_DOWN_AFTER_FAILURES = 3;

let botDownFailures = 0;
let botDownAlerted = false;

/** Exported for the tests, which drive the counter rather than a real bot. */
export function botDownState(): { failures: number; alerted: boolean } {
  return { failures: botDownFailures, alerted: botDownAlerted };
}

export async function checkBotAlive(
  sql: postgres.Sql,
  probe: () => Promise<boolean>,
): Promise<void> {
  const alive = await probe().catch(() => false);

  if (alive) {
    if (botDownAlerted) {
      await sendAlert("✅ Бот снова отвечает — стек живой.");
      await logIncident(sql, "bot_down", null, null, "none", "recovered", "");
      alertedAt.delete(BOT_DOWN_KEY);
    }
    botDownFailures = 0;
    botDownAlerted = false;
    return;
  }

  botDownFailures++;
  // A restart is a few seconds of refused connections and is not news. Three
  // probes is a minute of them.
  if (botDownFailures < BOT_DOWN_AFTER_FAILURES) return;
  if (!shouldAlert(BOT_DOWN_KEY)) return;

  botDownAlerted = true;
  await sendAlertWithButtons(
    "🔴 <b>Бот не отвечает</b>\n" +
      `Health-эндпоинт молчит или отдаёт ошибку ${botDownFailures} проверки подряд ` +
      "(503 — значит бот жив, но не видит базу).\n\n" +
      "Кнопка ниже поднимет то, что лежит — но её обрабатывает сам бот. " +
      "Если она не реагирует, значит бот действительно мёртв: пришли сюда <code>/up</code>, " +
      "команду примет хостовый демон напрямую.",
    [
      [{ text: "🔧 Восстановить", callback_data: stackUpCallbackData() }],
      [{ text: "🔕 Тишина на 1 ч", callback_data: `sup:ack:${BOT_DOWN_KEY}:0` }],
    ],
  );
  await logIncident(sql, "bot_down", null, null, "alert", "pending", "");
}

// --- Main entry point ---

export function startSupervisor(sql: postgres.Sql, runShell: RunShell): void {
  console.log("[supervisor] starting session health watchdog...");
  if (!SUPERVISOR_CHAT_ID || !SUPERVISOR_TOPIC_ID) {
    console.warn("[supervisor] SUPERVISOR_CHAT_ID or SUPERVISOR_TOPIC_ID not set — alerts will be logged only");
  }

  // In-flight guards (prevent overlapping concurrent executions)
  let sessionCheckRunning    = false;
  let queueCheckRunning      = false;
  let voiceCheckRunning      = false;
  let broadcastRunning       = false;
  let idleCheckRunning       = false;
  let contextCheckRunning    = false;
  let unansweredCheckRunning = false;

  // Loop 1: Session heartbeat — every 60s.
  //
  // Two checks on one timer, in order. The limit scan runs first because it
  // decides whether the hung check is about to call a session dead when it is
  // merely out of allowance, and because both ask the same database about the
  // same sessions — a second interval for the second question would only mean
  // the two could disagree about what "now" is.
  const sessionTimer = setInterval(() => {
    if (sessionCheckRunning) return;
    sessionCheckRunning = true;
    checkLimitedSessions(sql)
      .catch(() => {})
      .then(() => checkHungSessions(sql, runShell))
      .catch(() => {})
      .finally(() => { sessionCheckRunning = false; });
  }, 60_000);
  sessionTimer.unref?.();

  // Loop 2: Stuck queue — every 60s (offset 15s from session loop to spread DB load)
  setTimeout(() => {
    if (!queueCheckRunning) {
      queueCheckRunning = true;
      checkStuckQueue(sql, runShell).catch(() => {}).finally(() => { queueCheckRunning = false; });
    }
    const queueTimer = setInterval(() => {
      if (queueCheckRunning) return;
      queueCheckRunning = true;
      checkStuckQueue(sql, runShell).catch(() => {}).finally(() => { queueCheckRunning = false; });
    }, 60_000);
    queueTimer.unref?.();
  }, 15_000);

  // Loop 3: Voice cleanup — every 5 min
  const voiceTimer = setInterval(() => {
    if (voiceCheckRunning) return;
    voiceCheckRunning = true;
    cleanVoiceStatuses(sql).catch(() => {}).finally(() => { voiceCheckRunning = false; });
  }, 5 * 60_000);
  voiceTimer.unref?.();

  // Loop 4: Full status broadcast — every 5 min
  const statusTimer = setInterval(() => {
    if (broadcastRunning) return;
    broadcastRunning = true;
    sendStatusBroadcast(sql, runShell).catch(() => {}).finally(() => { broadcastRunning = false; });
  }, 5 * 60_000);
  statusTimer.unref?.();

  // Heartbeat to process_health — every 30s
  const healthTimer = setInterval(() => updateProcessHealth(sql).catch(() => {}), 30_000);
  healthTimer.unref?.();

  // Loop 5: Idle session auto-compact — every 30 min
  const idleTimer = setInterval(() => {
    if (idleCheckRunning) return;
    idleCheckRunning = true;
    checkIdleSessions(sql).catch(() => {}).finally(() => { idleCheckRunning = false; });
  }, 30 * 60_000);
  idleTimer.unref?.();

  // Loop 5b: Context pressure — every 2 min.
  //
  // Faster than the idle loop because it is racing something. A window fills
  // over minutes, and half an hour between looks is most of the time it takes.
  const contextTimer = setInterval(() => {
    if (contextCheckRunning) return;
    contextCheckRunning = true;
    checkContextPressure(sql, {
      readContext: readSessionContext,
      summarize: (sessionId, chatId) => forceSummarize(sessionId, chatId),
      sendKeys: runShell ? (project, keys) => typeIntoSession(runShell, project, keys) : undefined,
    }).catch(() => {}).finally(() => { contextCheckRunning = false; });
  }, 2 * 60_000);
  contextTimer.unref?.();

  // Loop 5c: the pulse — every 8 min, offset 65s.
  //
  // Offset because it posts, and because the readings it renders are gathered by
  // the two-minute loop above: starting it a minute in means its first pulse has
  // something to say. The interval is argued for at `PULSE_INTERVAL_MS`.
  setTimeout(() => {
    let pulseRunning = false;
    const pulseTimer = setInterval(() => {
      if (pulseRunning) return;
      pulseRunning = true;
      sendSessionPulse().catch(() => {}).finally(() => { pulseRunning = false; });
    }, PULSE_INTERVAL_MS);
    pulseTimer.unref?.();
  }, 65_000);

  // Loop 6: Gemma health analyst — every 10 min
  let gemmaHealthRunning = false;
  const gemmaHealthTimer = setInterval(() => {
    if (gemmaHealthRunning) return;
    gemmaHealthRunning = true;
    checkGemmaHealth(sql, runShell).catch(() => {}).finally(() => { gemmaHealthRunning = false; });
  }, 10 * 60_000);
  gemmaHealthTimer.unref?.();

  // Loop 7: Unanswered message detector — every 2 min (offset 45s to spread DB load)
  setTimeout(() => {
    if (!unansweredCheckRunning) {
      unansweredCheckRunning = true;
      checkUnansweredMessages(sql).catch(() => {}).finally(() => { unansweredCheckRunning = false; });
    }
    const unansweredTimer = setInterval(() => {
      if (unansweredCheckRunning) return;
      unansweredCheckRunning = true;
      checkUnansweredMessages(sql).catch(() => {}).finally(() => { unansweredCheckRunning = false; });
    }, 2 * 60_000);
    unansweredTimer.unref?.();
  }, 45_000);

  // Loop 8: Is the bot alive — every 20s. Faster than the rest because this is
  // the outage during which nothing else can report anything.
  const botHealthUrl = `http://localhost:${process.env.PORT ?? "3847"}/health`;
  // Deliberately `res.ok`, and deliberately not the same question the host
  // ingress asks. This one is "is the bot serving", so a 503 — which is what
  // it returns when Postgres is unreachable — counts as down and is worth an
  // alert. The ingress asks "is anything else reading this Telegram token",
  // where a 503 means yes and opening a second reader would 409 them both.
  // Same endpoint, opposite readings, and the two must not be unified.
  const probeBot = async (): Promise<boolean> => {
    try {
      const res = await fetch(botHealthUrl, { signal: AbortSignal.timeout(5_000) });
      return res.ok;
    } catch {
      return false;
    }
  };
  let botAliveRunning = false;
  const botAliveTimer = setInterval(() => {
    if (botAliveRunning) return;
    botAliveRunning = true;
    checkBotAlive(sql, probeBot).catch(() => {}).finally(() => { botAliveRunning = false; });
  }, 20_000);
  botAliveTimer.unref?.();

  // Loop 9: the bot's own error stream — every 90s, offset 25s from the rest.
  // Reads only what has been appended since the last pass, so the interval is
  // its own rate limit.
  const errorStream = createErrorStreamReader();
  setTimeout(() => {
    let errorStreamRunning = false;
    const errorStreamTimer = setInterval(() => {
      if (errorStreamRunning) return;
      errorStreamRunning = true;
      checkErrorStream(errorStream).catch(() => {}).finally(() => { errorStreamRunning = false; });
    }, 90_000);
    errorStreamTimer.unref?.();
  }, 25_000);

  // Loop 10: can the reviewers review — every 30 min, offset 50s. A probe, not
  // a review: it costs one HTTP call and one `codex login status`, where
  // reviewing costs ten minutes.
  setTimeout(() => {
    let reviewerHealthRunning = false;
    const reviewerHealthTimer = setInterval(() => {
      if (reviewerHealthRunning) return;
      reviewerHealthRunning = true;
      checkReviewerHealth({
        statuses: getReviewerStatuses,
        alert: async (text, key) => {
          if (!shouldAlert(key)) return;
          await sendAlertWithButtons(text, [[{ text: "🔕 Тишина на 1 ч", callback_data: `sup:ack:${key}:0` }]]);
        },
        clear: async (text) => { await sendAlert(text); },
      }).catch(() => {}).finally(() => { reviewerHealthRunning = false; });
    }, 30 * 60_000);
    reviewerHealthTimer.unref?.();
  }, 50_000);

  // Loop 11: a review nobody asked for — every 15 min. Two passes with the same
  // diff hash is what "the branch stopped changing" means.
  setTimeout(() => {
    let scheduledReviewRunning = false;
    const scheduledReviewTimer = setInterval(() => {
      if (scheduledReviewRunning) return;
      scheduledReviewRunning = true;
      maybeRunScheduledReview(scheduledReviewDeps(sql, runShell))
        .catch(() => {})
        .finally(() => { scheduledReviewRunning = false; });
    }, 15 * 60_000);
    scheduledReviewTimer.unref?.();
  }, 70_000);

  // Loop: Recovery check — every 60s (offset 30s from session loop)
  setTimeout(() => {
    const recoveryTimer = setInterval(() => {
      checkRecovery(sql).catch(() => {});
    }, 60_000);
    recoveryTimer.unref?.();
  }, 30_000);

  // Run initial checks after a short delay (let admin-daemon settle first)
  setTimeout(() => {
    checkLimitedSessions(sql).catch(() => {});
    checkHungSessions(sql, runShell).catch(() => {});
    cleanVoiceStatuses(sql).catch(() => {});
    updateProcessHealth(sql).catch(() => {});
    // First status broadcast after 30s settle time
    setTimeout(() => sendStatusBroadcast(sql, runShell).catch(() => {}), 20_000);
    // First Gemma health check after 2 min (give system time to stabilize)
    setTimeout(() => checkGemmaHealth(sql, runShell).catch(() => {}), 2 * 60_000);
  }, 10_000);

  // The inventory, said out loud. It listed seven loops while eleven were
  // running — found by the test that counts the registrations, and a log line
  // that under-reports what is running is the same class of quiet untruth this
  // supervisor exists to catch.
  console.error(
    "[supervisor] watchdog running (session+limits:60s, queue:60s, process-health:30s, voice:5min, " +
      `status:5min, idle-compact:30min/${IDLE_COMPACT_MIN}min-threshold, pulse:8min, gemma-health:10min, ` +
      "unanswered:2min, bot-alive:20s, error-stream:90s, reviewer-health:30min, " +
      "scheduled-review:15min, recovery:60s)",
  );
}

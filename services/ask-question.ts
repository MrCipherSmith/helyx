/**
 * The question service: register, ask, wait, answer.
 *
 * Everything here takes its database and its Telegram sender as arguments so
 * the whole path can be driven in a test without a network or a real chat —
 * which matters more than usual, because the failure this fixes is invisible
 * from the terminal and the terminal is the only place it was ever observed.
 *
 * See `utils/ask-question.ts` for why an answer comes back as a refusal, and
 * why nothing here touches the tmux pane.
 */

import type postgres from "postgres";
import {
  allAnswered,
  parseAnswerCallback,
  questionMessage,
  shortRequestId,
  type HookInput,
  type Question,
} from "../utils/ask-question.ts";

export interface SendResult {
  ok: boolean;
  messageId: number | null;
}

export interface AskDeps {
  sql: postgres.Sql;
  sendMessage: (chatId: string, text: string, extra: Record<string, unknown>) => Promise<SendResult>;
  editMessage: (chatId: string, messageId: number, text: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RegisteredQuestions {
  requestId: string;
  chatId: string;
  questions: Question[];
}

/** Where a session's questions should be sent, or null if there is nowhere. */
export async function resolveTarget(
  sql: postgres.Sql,
  input: { sessionId: string; cwd: string },
): Promise<{ sessionId: number; chatId: string; extra: Record<string, unknown> } | null> {
  // Resolved by working directory rather than by Claude's session id: the
  // session id in the hook payload is Claude Code's own UUID, which is not the
  // helyx session row's id and has no column to match against.
  const rows = await sql`
    SELECT
      s.id AS session_id,
      cs.chat_id,
      p.forum_topic_id,
      bc.value AS forum_chat_id
    FROM sessions s
    LEFT JOIN chat_sessions cs ON cs.active_session_id = s.id
    LEFT JOIN projects p       ON p.name = s.project
    LEFT JOIN bot_config bc    ON bc.key = 'forum_chat_id'
    WHERE s.status = 'active'
      AND s.id != 0
      AND s.project_path = ${input.cwd}
    ORDER BY s.last_active DESC
    LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);

  const row = rows[0];
  if (!row) return null;

  const forumChatId = (row.forum_chat_id as string) || null;
  const forumTopicId = row.forum_topic_id as number | null;
  if (forumChatId && forumTopicId) {
    return {
      sessionId: Number(row.session_id),
      chatId: forumChatId,
      extra: { message_thread_id: forumTopicId },
    };
  }
  const chatId = (row.chat_id as string) || null;
  if (!chatId) return null;
  return { sessionId: Number(row.session_id), chatId, extra: {} };
}

/**
 * Put the questions in the database and on the operator's screen.
 *
 * The row is written before the first message is sent. A button pressed the
 * instant it appears must find a row to write its answer into, and Telegram
 * delivers faster than a second round-trip to Postgres.
 */
export async function registerQuestions(
  deps: AskDeps,
  input: HookInput,
): Promise<RegisteredQuestions | null> {
  const target = await resolveTarget(deps.sql, input);
  if (!target) return null;

  const requestId = shortRequestId(deps.random ?? Math.random);
  await deps.sql`
    INSERT INTO question_requests (id, session_id, chat_id, project_path, questions, answers)
    VALUES (${requestId}, ${target.sessionId}, ${target.chatId}, ${input.cwd},
            ${deps.sql.json(input.questions as never)}, ${deps.sql.json(input.questions.map(() => null) as never)})
    ON CONFLICT (id) DO NOTHING
  `;

  const messageIds: (number | null)[] = [];
  for (const [index, question] of input.questions.entries()) {
    const { text, buttons } = questionMessage(requestId, index, question);
    const sent = await deps.sendMessage(target.chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
      ...target.extra,
    });
    messageIds.push(sent.ok ? sent.messageId : null);
  }

  // Nothing reached the operator, so nothing can be answered. Say so rather
  // than waiting ten minutes for a reply to a message that was never sent.
  if (messageIds.every((id) => id === null)) {
    await deps.sql`DELETE FROM question_requests WHERE id = ${requestId}`.catch(() => {});
    return null;
  }

  await deps.sql`
    UPDATE question_requests SET message_ids = ${deps.sql.json(messageIds as never)} WHERE id = ${requestId}
  `.catch(() => {});

  return { requestId, chatId: target.chatId, questions: input.questions };
}

/**
 * Wait until every question has an answer, or until the deadline.
 *
 * Returns `null` on timeout, which the hook turns into silence: Claude Code
 * then proceeds as though no hook had run, the selector is drawn, and the
 * terminal works as it always did. That fallback is the reason this can be
 * added without making anything worse.
 */
export async function waitForAnswers(
  deps: AskDeps,
  requestId: string,
  expected: number,
  timeoutMs: number,
  pollMs = 1_000,
): Promise<(number | null)[] | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const rows = await deps.sql`
      SELECT answers FROM question_requests WHERE id = ${requestId}
    `.catch(() => [] as Record<string, unknown>[]);

    // The row is gone — cancelled, or cleaned up. Nothing left to wait for.
    if (rows.length === 0) return null;

    const answers = normaliseAnswers(rows[0]!.answers, expected);
    if (allAnswered(answers, expected)) {
      await deps.sql`
        UPDATE question_requests SET answered_at = NOW() WHERE id = ${requestId} AND answered_at IS NULL
      `.catch(() => {});
      return answers;
    }
    await sleep(pollMs);
  }
  return null;
}

/** JSONB comes back as whatever was stored; only an array of indices is usable. */
function normaliseAnswers(raw: unknown, expected: number): (number | null)[] {
  const list = Array.isArray(raw) ? raw : [];
  const answers: (number | null)[] = [];
  for (let i = 0; i < expected; i++) {
    const value = list[i];
    answers.push(typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
  }
  return answers;
}

export type AnswerOutcome =
  | { status: "recorded"; label: string; complete: boolean }
  | { status: "not-ours" }
  | { status: "unknown" }
  | { status: "already-answered" }
  | { status: "out-of-range" };

/**
 * Record one tapped button.
 *
 * Every rejection is a distinct outcome rather than a silent no-op, because the
 * caller answers the operator: a button that does nothing and says nothing is
 * the same experience as the bug this fixes.
 */
export async function recordAnswer(deps: AskDeps, callbackData: string): Promise<AnswerOutcome> {
  const parsed = parseAnswerCallback(callbackData);
  if (!parsed) return { status: "not-ours" };

  const rows = await deps.sql`
    SELECT questions, answers, answered_at, chat_id, message_ids
    FROM question_requests WHERE id = ${parsed.requestId}
  `.catch(() => [] as Record<string, unknown>[]);
  const row = rows[0];
  if (!row) return { status: "unknown" };
  if (row.answered_at) return { status: "already-answered" };

  const questions = (Array.isArray(row.questions) ? row.questions : []) as Question[];
  const question = questions[parsed.questionIndex];
  const option = question?.options?.[parsed.optionIndex];
  if (!option) return { status: "out-of-range" };

  const answers = normaliseAnswers(row.answers, questions.length);
  answers[parsed.questionIndex] = parsed.optionIndex;

  await deps.sql`
    UPDATE question_requests SET answers = ${deps.sql.json(answers as never)} WHERE id = ${parsed.requestId}
  `;

  const complete = allAnswered(answers, questions.length);

  // The keyboard is replaced with the chosen answer, so the message shows what
  // was picked rather than still offering the choice.
  const messageIds = (Array.isArray(row.message_ids) ? row.message_ids : []) as (number | null)[];
  const messageId = messageIds[parsed.questionIndex];
  if (typeof messageId === "number") {
    const { text } = questionMessage(parsed.requestId, parsed.questionIndex, question!);
    await deps
      .editMessage(String(row.chat_id), messageId, `${text}\n\n✅ <b>Выбрано: ${escapeHtml(option.label)}</b>`)
      .catch(() => {});
  }

  return { status: "recorded", label: option.label, complete };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Is this session waiting on a question right now?
 *
 * The supervisor asks, so that a session standing still because it asked
 * something is not reported as hung. That false alarm is how the outage was
 * noticed: two "session is not responding" alerts and no sign of the question.
 */
export async function hasOpenQuestion(sql: postgres.Sql, sessionId: number): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM question_requests
    WHERE session_id = ${sessionId} AND answered_at IS NULL
      AND created_at > NOW() - INTERVAL '15 minutes'
    LIMIT 1
  `.catch(() => [] as unknown[]);
  return rows.length > 0;
}

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
  /**
   * `extra` carries `reply_markup` — an empty keyboard removes the buttons.
   * Optional so existing callers are unaffected.
   */
  editMessage: (chatId: string, messageId: number, text: string, extra?: Record<string, unknown>) => Promise<void>;
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

  // Every question must have reached the operator, not merely one of them.
  //
  // A partial delivery is the worst outcome available: the questions that did
  // arrive can be answered, the one that did not never can, the call therefore
  // never completes — and meanwhile the terminal selector is suppressed for the
  // full ten minutes. Withdrawing puts it straight back.
  if (messageIds.some((id) => id === null)) {
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
  /**
   * Whether the client is still there. Checked every poll, not once before the
   * loop: a hook whose curl gives up mid-wait would otherwise hold a waiter
   * slot for the full ten minutes, and enough of those stop any further
   * question being delivered at all.
   */
  clientGone: () => boolean = () => false,
): Promise<(number | null)[] | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    if (clientGone()) {
      await expireRequest(deps, requestId);
      return null;
    }

    const rows = await deps.sql`
      SELECT answers, expired_at FROM question_requests WHERE id = ${requestId}
    `.catch(() => [] as Record<string, unknown>[]);

    // The row is gone — cancelled, or cleaned up. Nothing left to wait for.
    if (rows.length === 0) return null;

    // Cancelled from elsewhere — the client hung up and the endpoint expired it.
    if (rows[0]!.expired_at) return null;

    const answers = normaliseAnswers(rows[0]!.answers, expected);
    if (allAnswered(answers, expected)) {
      // The transition has to win, not merely be attempted.
      //
      // `AND expired_at IS NULL` keeps the two terminal states exclusive, but a
      // guarded update that matches nothing is not a failure the caller can
      // ignore: it means a cancel landed first. Returning the answers anyway
      // would hand Claude a choice the operator was already told had expired.
      const claimed = await deps.sql`
        UPDATE question_requests SET answered_at = NOW()
         WHERE id = ${requestId} AND answered_at IS NULL AND expired_at IS NULL
        RETURNING answers
      `.catch(() => [] as Record<string, unknown>[]);
      if (claimed.length === 0) return null;

      // The answers as the claim froze them, not as they were read a statement
      // earlier. A tap landing between the two changes a slot, and returning
      // the older snapshot would hand Claude one option while the row and the
      // operator's own message both record another.
      const committed = normaliseAnswers(claimed[0]!.answers, expected);
      // If what was committed is not a complete set after all, the terminal
      // keeps the question. Handing Claude "(no answer)" for a slot would be a
      // worse outcome than asking again.
      return allAnswered(committed, expected) ? committed : null;
    }
    await sleep(pollMs);
  }

  // Stopped waiting. The messages say so and lose their buttons, rather than
  // sitting there looking live until someone taps one and is told otherwise.
  await expireRequest(deps, requestId);
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
  | { status: "expired" }
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
    SELECT questions, answers, answered_at, expired_at, chat_id, message_ids
    FROM question_requests WHERE id = ${parsed.requestId}
  `.catch(() => [] as Record<string, unknown>[]);
  const row = rows[0];
  if (!row) return { status: "unknown" };
  // Expiry is checked first. The two are meant to be exclusive, and if a row
  // ever carries both, "no longer waiting" is the true thing to say — reporting
  // a send to a waiter that has gone is the failure worth avoiding.
  if (row.expired_at) return { status: "expired" };
  if (row.answered_at) return { status: "already-answered" };

  const questions = (Array.isArray(row.questions) ? row.questions : []) as Question[];
  const question = questions[parsed.questionIndex];
  const option = question?.options?.[parsed.optionIndex];
  if (!option) return { status: "out-of-range" };

  // One slot, set in place by the database.
  //
  // Reading the array here and writing it back would lose an answer whenever
  // two buttons are tapped at once — each write carrying the other's slot as it
  // was before. `jsonb_set` touches only the element being answered, so the two
  // updates compose however they interleave. The row is read back rather than
  // recomputed locally, for the same reason.
  const updated = await deps.sql`
    UPDATE question_requests
       SET answers = jsonb_set(answers, ARRAY[${String(parsed.questionIndex)}], ${parsed.optionIndex}::text::jsonb, true)
     WHERE id = ${parsed.requestId} AND answered_at IS NULL AND expired_at IS NULL
    RETURNING answers
  `.catch(() => [] as Record<string, unknown>[]);

  if (updated.length === 0) {
    // Something beat this tap between the read above and the write. Which one
    // decides what the operator is told, so it is read rather than assumed —
    // "already answered" and "no longer waiting" are different messages and
    // guessing gets it wrong exactly when the race is real.
    return await terminalOutcome(deps, parsed.requestId);
  }

  const answers = normaliseAnswers(updated[0]!.answers, questions.length);
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

/** Which terminal state a request ended in, for a tap that arrived too late. */
async function terminalOutcome(deps: AskDeps, requestId: string): Promise<AnswerOutcome> {
  const rows = await deps.sql`
    SELECT answered_at, expired_at FROM question_requests WHERE id = ${requestId}
  `.catch(() => [] as Record<string, unknown>[]);
  const row = rows[0];
  if (!row) return { status: "unknown" };
  if (row.expired_at) return { status: "expired" };
  if (row.answered_at) return { status: "already-answered" };
  // Neither, which means the guard failed for a reason this code does not
  // model. Reported as unknown rather than dressed up as one of the two.
  return { status: "unknown" };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ExchangeLimits {
  /** How long to wait for the operator. */
  timeoutMs: number;
  /** A signal that the client has gone away — the hook's curl giving up. */
  clientGone: () => boolean;
  /** Poll interval; the default is a second. */
  pollMs?: number;
}

/**
 * The whole exchange: place the questions, wait, and clean up after a client
 * that left.
 *
 * Extracted from the HTTP handler because the ordering here is the part that
 * was wrong twice. Capacity and the disconnect watch have to be in place before
 * any Telegram message is sent, and a client that hangs up mid-registration has
 * to be noticed — neither of which is observable from a test that can only
 * reach the endpoint.
 */
export async function runQuestionExchange(
  deps: AskDeps,
  input: HookInput,
  limits: ExchangeLimits,
): Promise<(number | null)[] | null> {
  const registered = await registerQuestions(deps, input);
  if (!registered) return null;

  // Gone while the questions were being sent. Starting a ten-minute wait for a
  // reader that has already left is the exact shape of the original bug.
  if (limits.clientGone()) {
    await expireRequest(deps, registered.requestId);
    return null;
  }

  return waitForAnswers(
    deps,
    registered.requestId,
    input.questions.length,
    limits.timeoutMs,
    limits.pollMs ?? 1_000,
    limits.clientGone,
  );
}

/**
 * What an expired question's message says instead of offering a choice.
 *
 * The buttons are removed, not just annotated. Left in place they look live —
 * and that is the whole complaint: an operator taps a question ten minutes old,
 * gets told it is no longer waiting, and has no way to have known that before
 * tapping. The hook cannot tell them, because it cannot tell either: it posts
 * the question, and if the tool call was abandoned in the terminal meanwhile,
 * nothing informs it. So the message says so when the wait ends.
 */
export async function expireRequest(deps: AskDeps, requestId: string): Promise<void> {
  const claimed = await deps.sql`
    UPDATE question_requests SET expired_at = NOW()
     WHERE id = ${requestId} AND answered_at IS NULL AND expired_at IS NULL
    RETURNING chat_id, questions, message_ids
  `.catch(() => [] as Record<string, unknown>[]);

  // Nothing claimed: already answered, already expired, or gone. Either way
  // there is no live keyboard of ours left to take down.
  const row = claimed[0];
  if (!row) return;

  const questions = (Array.isArray(row.questions) ? row.questions : []) as Question[];
  const messageIds = (Array.isArray(row.message_ids) ? row.message_ids : []) as (number | null)[];

  for (const [index, messageId] of messageIds.entries()) {
    if (typeof messageId !== "number") continue;
    const question = questions[index];
    if (!question) continue;
    const { text } = questionMessage(requestId, index, question);
    await deps
      .editMessage(String(row.chat_id), messageId, `${text}\n\n⌛ <b>Вопрос больше не ждёт ответа</b>`, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  }
}

/**
 * Stop waiting on behalf of a client that hung up.
 *
 * The hook's curl gives up before the hook's own budget does, and when it does
 * the endpoint is still polling for an answer nobody will collect. Expiring the
 * request ends the poll and turns the buttons still on screen into an honest
 * "no longer waiting".
 */
export async function cancelRequest(deps: AskDeps, requestId: string): Promise<void> {
  await expireRequest(deps, requestId);
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
    WHERE session_id = ${sessionId} AND answered_at IS NULL AND expired_at IS NULL
      AND created_at > NOW() - INTERVAL '15 minutes'
    LIMIT 1
  `.catch(() => [] as unknown[]);
  return rows.length > 0;
}

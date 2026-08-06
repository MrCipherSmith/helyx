/**
 * `/now` — what the session is doing, answered without asking it.
 *
 * The operator asks this more than anything else, and it was the question the
 * system answered worst: a message goes through `message_queue`, the poller
 * holds it while the chat is busy so that each message gets its own turn, and
 * the answer therefore arrives when the turn ends. A wedged session never
 * answers at all.
 *
 * Nothing here queues anything. The transcript already says what the session is
 * doing, and since flow 045 it says what its subagents are doing too, so this
 * reads the record and renders it. The two lines of interpretation come from
 * the same local model the supervisor already uses for its health digests, and
 * their absence costs two lines and nothing else.
 *
 * The button under the card is the other half: when the session's *own* answer
 * is wanted, it queues a question the way a message always has — there is no
 * second delivery path, because the existing one is the only one that respects
 * a turn.
 */

import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";
import { routeMessage } from "../../sessions/router.ts";
import { resolveTranscript, TranscriptTail, claudeConfigRoot } from "../../utils/transcript-locate.ts";
import { findSubagents, markLines } from "../../utils/subagent-transcripts.ts";
import { renderEntry } from "../../utils/transcript-events.ts";
import { parseEntry } from "../../utils/transcript-locate.ts";
import { snapshotFrom, NO_SESSION, type SessionSnapshot } from "../../utils/session-snapshot.ts";
import { renderNow } from "../../utils/now-render.ts";
import { hasOpenQuestion } from "../../services/ask-question.ts";
import { logger } from "../../logger.ts";
import { replyInThread } from "../format.ts";
import { editTelegramMessage } from "../../channel/telegram.ts";
import { CONFIG } from "../../config.ts";
import { readdir, stat, readFile } from "fs/promises";

/** How far back the card looks. Enough for a turn, short enough to read fast. */
export const WINDOW_BYTES = 64 * 1024;

/**
 * Where the local model lives, and how long it may take.
 *
 * No default: inside the container a loopback address would point at the
 * container itself, where nothing is listening — `docker-compose.yml` sets
 * `OLLAMA_URL` to `host.docker.internal`. An unset variable means no model, and
 * no model means the card renders without its two lines, which it is built to
 * do anyway. (The security gate also refuses a loopback literal in this path,
 * and it is right to: a hardcoded one would be wrong here in both directions.)
 */
const OLLAMA_URL = process.env.OLLAMA_URL ?? null;
const READING_TIMEOUT_MS = 6_000;

/**
 * The card message per chat, so pressing again edits rather than sends.
 *
 * Ten presses in a topic must not be ten messages: the operator presses this
 * when they are impatient, which is exactly when they press it repeatedly.
 */
const cards = new Map<string, { messageId: number; at: number }>();

/**
 * How long a remembered card is worth editing.
 *
 * Telegram refuses to edit an old message anyway, and without a bound the map
 * keeps one entry per topic for the life of the process. Raised in review.
 */
export const CARD_TTL_MS = 30 * 60_000;

/** For tests: what the command sends and where it reads from. */
export interface NowDeps {
  sql: typeof sql;
  root?: string;
  /** The two lines of interpretation, or null. */
  reading: (snapshot: SessionSnapshot, project: string) => Promise<string | null>;
  hasOpenQuestion: typeof hasOpenQuestion;
  /**
   * Routing, injected with the same `sql` as everything else here.
   *
   * `routeMessage` defaults to the module-level client, so a test that replaced
   * only this file's `sql` would still have routing talk to the real database —
   * which it did, once, and the test passed for the wrong reason.
   */
  route: (chatId: string, topicId?: number) => ReturnType<typeof routeMessage>;
  /**
   * Reading the record, injected so a test never touches the operator's real
   * `~/.claude` — which the first version of the test did, and passed against
   * this very session's transcript.
   */
  snapshot: (projectPath: string) => Promise<SessionSnapshot>;
  now: () => number;
}

const PRODUCTION_DEPS: NowDeps = {
  sql,
  reading: readingFromModel,
  hasOpenQuestion,
  route: (chatId, topicId) => routeMessage(chatId, topicId),
  snapshot: (projectPath) => snapshotForProject(projectPath),
  now: () => Date.now(),
};

let deps: NowDeps = PRODUCTION_DEPS;

/** Stand something else in for a test; the returned function puts it back. */
export function setNowDeps(next: Partial<NowDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => { deps = previous; };
}

/**
 * Two lines from the local model, or nothing.
 *
 * The same shape as the supervisor's health digest: a snapshot in, a short
 * answer out, cheap and independent of the session. It is allowed to fail —
 * the card above it is the answer.
 */
async function readingFromModel(snapshot: SessionSnapshot, project: string): Promise<string | null> {
  if (!OLLAMA_URL) return null;
  if (!snapshot.found || !snapshot.lastLine) return null;
  const model = process.env.SUMMARIZE_MODEL || process.env.OLLAMA_CHAT_MODEL || "gemma4:e4b";
  const agents = snapshot.agents.map((a) => `${a.label}: ${a.lastLine ?? "—"}`).join("\n");

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "Ты читаешь последние строки работы сессии Claude Code. Ответь ДВУМЯ строками на русском: первая — чем сессия занята сейчас, вторая — что, судя по этим строкам, осталось. Без вступлений, без вопросов, без списков.",
          },
          {
            role: "user",
            content: `Проект: ${project}\nПоследнее: ${snapshot.lastLine}\nИнструментов за ход: ${snapshot.tools}, файлов: ${snapshot.files}\n${agents}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(READING_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { message?: { content?: string } };
    const text = data.message?.content?.trim();
    return text ? text.split("\n").slice(0, 2).join("\n") : null;
  } catch {
    // A model that is down costs the two lines. That is the whole contract.
    return null;
  }
}

/**
 * Read the session's own record, and its subagents', without disturbing either.
 *
 * The window is the tail of the file: a turn's worth, and nothing is written
 * back, so this cannot interfere with the monitor reading the same file — two
 * readers of an append-only file are independent.
 *
 * Starting mid-file means the first line read is usually a fragment, and a
 * fragment is not valid JSON, so `parseEntry` returns null and it is skipped.
 * That is deliberate: the alternative is scanning back for a newline, and one
 * dropped line at the far end of the window is worth less than the complexity.
 * The same answer covers an offset that lands inside a multi-byte character.
 */
export async function snapshotForProject(projectPath: string, root?: string): Promise<SessionSnapshot> {
  const path = await resolveTranscript(projectPath, root ?? claudeConfigRoot());
  if (!path) return NO_SESSION;

  const size = Bun.file(path).size;
  const tail = TranscriptTail.at(path, Math.max(0, size - WINDOW_BYTES));
  const lines = await tail.read().catch(() => [] as string[]);

  const files = {
    readdir: (dir: string) => readdir(dir),
    stat: async (p: string) => ({ mtimeMs: (await stat(p)).mtimeMs }),
    readFile: (p: string) => readFile(p, "utf-8"),
  };

  const agentFiles = await findSubagents(path, {
    since: Date.now() - 30 * 60_000,
    files,
  }).catch(() => []);

  const agents = [];
  for (const file of agentFiles) {
    const agentSize = Bun.file(file.path).size;
    const agentTail = TranscriptTail.at(file.path, Math.max(0, agentSize - WINDOW_BYTES));
    const agentLines = await agentTail.read().catch(() => [] as string[]);
    const rendered = agentLines.flatMap((line) => renderEntry(parseEntry(line)));
    agents.push({ label: file.label, lines: markLines(file.label, rendered) });
  }

  return snapshotFrom({ lines, agents, now: Date.now() });
}

/** `/now` — the card. */
export async function handleNow(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const topicId = ctx.message?.message_thread_id;
  const route = await deps.route(chatId, topicId).catch(() => null);
  const project = route?.projectPath ?? null;
  // The project's own name when routing found one, and the path's last segment
  // otherwise: the card's first line has to say which session it is about.
  const name = project ? project.split("/").filter(Boolean).at(-1) ?? project : "standalone";

  const snapshot = project ? await deps.snapshot(project) : NO_SESSION;
  const openQuestion = route?.sessionId
    ? await deps.hasOpenQuestion(deps.sql, route.sessionId).catch(() => false)
    : false;
  const withQuestion: SessionSnapshot = openQuestion ? { ...snapshot, waiting: "question" } : snapshot;

  const reading = await deps.reading(withQuestion, name).catch(() => null);
  const text = renderNow({ project: name, snapshot: withQuestion, reading });

  const key = topicId ? `${chatId}:${topicId}` : chatId;
  for (const [k, card] of cards) {
    if (deps.now() - card.at > CARD_TTL_MS) cards.delete(k);
  }
  const remembered = cards.get(key);
  const existing = remembered && deps.now() - remembered.at <= CARD_TTL_MS ? remembered.messageId : undefined;
  const token = CONFIG.TELEGRAM_BOT_TOKEN;

  const markup = {
    inline_keyboard: [[{ text: "🗣 Спросить сессию", callback_data: "now:ask" }]],
  };

  if (existing && token) {
    const res = await editTelegramMessage(token, chatId, existing, text, {
      parse_mode: "HTML",
      reply_markup: markup,
    });
    // Edited in place — no new message. A card that could not be edited (too
    // old, or deleted by hand) falls through to a fresh one below.
    if (res.ok) return;
    cards.delete(key);
  }

  const sent = await replyInThread(ctx, text, { parse_mode: "HTML", reply_markup: markup });
  const messageId = (sent as { message_id?: number } | undefined)?.message_id;
  if (messageId) cards.set(key, { messageId, at: deps.now() });
  logger.info({ chatId, project: name, waiting: withQuestion.waiting }, "now card sent");
}

/**
 * The button under the card: ask the session itself.
 *
 * Queued through `message_queue` exactly as a message is. There is deliberately
 * no second delivery path — the existing one is the only one that respects a
 * turn, and a question that jumped it would arrive mid-thought and be answered
 * about the wrong thing.
 */
export async function handleNowCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id ?? "");
  const topicId = ctx.callbackQuery?.message?.message_thread_id;
  const fromUser = ctx.from?.username ?? ctx.from?.first_name ?? "user";
  const route = await deps.route(chatId, topicId).catch(() => null);

  if (!route || route.mode !== "cli") {
    await ctx.answerCallbackQuery({ text: "Здесь нет сессии, которую можно спросить" });
    return;
  }

  // The id is synthetic and must not collide: the unique index on
  // (chat_id, message_id) would reject a second press in the same millisecond,
  // and an unhandled rejection here would leave the button looking dead.
  // Raised in review.
  const messageId = `now-${deps.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await deps.sql`
    INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
    VALUES (${route.sessionId}, ${chatId}, ${fromUser}, ${QUESTION}, ${messageId})
    ON CONFLICT (chat_id, message_id)
      WHERE message_id IS NOT NULL AND message_id != '' AND message_id != 'tool'
    DO NOTHING
  `.catch((err: unknown) => {
    logger.warn({ err }, "now: could not queue the question");
  });
  await ctx.answerCallbackQuery({ text: "Спросил — ответит, когда закончит текущий шаг" });
}

/**
 * What the button asks.
 *
 * Fixed wording, because it is answered by a model and the answer is only as
 * good as the question: "какой статус" invites a paragraph, and this invites
 * three lines.
 */
export const QUESTION =
  "Что сейчас в работе, что уже сделано и что осталось? Ответь тремя короткими строками, без вступления.";

/** For tests, and for a chat that has been reset. */
export function forgetCard(chatId: string, topicId?: number): void {
  cards.delete(topicId ? `${chatId}:${topicId}` : chatId);
}

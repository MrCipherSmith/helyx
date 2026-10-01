/**
 * `handlePollSubmit`'s INSERT into `message_queue` used a bare `'poll_submit'`
 * literal as `message_id`. `idx_queue_msgid_dedup` (memory/db.ts:478-488) is
 * UNIQUE on `(chat_id, message_id)`, so the first poll ever submitted in a
 * given Telegram chat claimed that slot and every later poll submission in
 * the SAME chat — across every project sharing it, not just one session —
 * raised a duplicate-key error. The surrounding try/catch swallowed it, and
 * `poll_sessions.status` was already set to 'submitted' by the UPDATE just
 * above the INSERT, so the poll looked successful while its answers never
 * reached `message_queue` at all.
 *
 * `tests/unit/supervisor-rescue-dedup-index.test.ts` hit the identical bug on
 * the same index and found the same root cause: a `FakeSql` test records an
 * INSERT as sent and enforces no constraint, so it cannot see a real unique
 * index reject it. This file runs against the real database `tests/preload.ts`
 * provisions for the run — same pattern as `session-delete-guards.test.ts` —
 * and skips cleanly when none is reachable.
 */

import { describe, test, expect } from "bun:test";
import { sql } from "../../memory/db.ts";
import { handlePollSubmit } from "../../bot/poll-handler.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";

const TEST_DATABASE_ENV = "HELYX_TEST_DATABASE";
const hasDatabase = Boolean(process.env[TEST_DATABASE_ENV]);

/** A fake grammY context: just enough for handlePollSubmit's calls. */
function fakeCtx() {
  return {
    answerCallbackQuery: async () => {},
    editMessageText: async () => {},
  } as unknown as Parameters<typeof handlePollSubmit>[0];
}

let seq = 0;

/** A fully-answered, pending poll session, ready to submit. */
async function seedAnsweredPoll(chatId: string, title: string): Promise<{ sessionId: number; pollSessionId: number }> {
  seq += 1;
  const clientId = `poll-dedup-test-${Date.now()}-${seq}`;
  const pollId = `poll-${Date.now()}-${seq}`;

  const [session] = await sql<{ id: number }[]>`
    INSERT INTO sessions (name, project, project_path, client_id, status)
    VALUES ('poll-dedup-test-session', 'poll-dedup-test', '/tmp/poll-dedup-test', ${clientId}, 'active')
    RETURNING id
  `;
  const sessionId = session!.id;

  const [pollSession] = await sql<{ id: number }[]>`
    INSERT INTO poll_sessions
      (session_id, chat_id, title, questions, telegram_poll_ids, answers, status, created_at)
    VALUES (
      ${sessionId}, ${chatId}, ${title},
      ${sql.json([{ question: "Q?", options: ["A", "B"] }])},
      ${sql.json([pollId])},
      ${sql.json({ [pollId]: 0 })},
      'pending', now()
    )
    RETURNING id
  `;

  return { sessionId, pollSessionId: pollSession!.id };
}

describe.skipIf(!hasDatabase)("handlePollSubmit, against a real database with idx_queue_msgid_dedup", () => {
  let http: FakeFetch;
  let restore: () => void;

  function setup() {
    ({ http, restore } = installFakeFetch());
    http.program("api.telegram.org", { json: { ok: true, result: { message_id: 1 } } });
  }

  test("a second poll submission in the same chat is not swallowed by the first one's dedup slot", async () => {
    setup();
    try {
      const chatId = `-100${Date.now()}${seq}`;
      const first = await seedAnsweredPoll(chatId, "First poll");
      const second = await seedAnsweredPoll(chatId, "Second poll");

      await handlePollSubmit(fakeCtx(), first.pollSessionId);
      await handlePollSubmit(fakeCtx(), second.pollSessionId);

      const rows = await sql<{ content: string }[]>`
        SELECT content FROM message_queue WHERE chat_id = ${chatId} ORDER BY id
      `;

      // Before the fix: the second INSERT collides with the first's
      // (chat_id, 'poll_submit') slot, throws, and is swallowed — exactly one
      // row reaches the queue no matter how many polls submit in this chat.
      const joined = rows.map((r) => r.content).join("\n");
      expect(joined).toContain("First poll");
      expect(joined).toContain("Second poll");
      expect(rows).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test("both poll sessions end up marked submitted, matching the delivered answers", async () => {
    setup();
    try {
      const chatId = `-100${Date.now()}${seq}`;
      const first = await seedAnsweredPoll(chatId, "First poll");
      const second = await seedAnsweredPoll(chatId, "Second poll");

      await handlePollSubmit(fakeCtx(), first.pollSessionId);
      await handlePollSubmit(fakeCtx(), second.pollSessionId);

      const statuses = await sql<{ id: number; status: string }[]>`
        SELECT id, status FROM poll_sessions WHERE id IN (${first.pollSessionId}, ${second.pollSessionId})
      `;
      for (const row of statuses) expect(row.status).toBe("submitted");

      // The thing 'submitted' is supposed to mean: an answer actually sitting
      // in message_queue for each poll, not just a status flip.
      const count = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM message_queue WHERE chat_id = ${chatId}
      `;
      expect(Number(count[0]!.n)).toBe(2);
    } finally {
      restore();
    }
  });
});

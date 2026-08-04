/**
 * The toggle, run against a database that actually executes it.
 *
 * The fake database records queries and returns programmed rows; it does not
 * parse SQL. So the whole multi-select suite passed while the toggle was
 * wrong: `answers` is a jsonb *array*, and `array -> '0'` is NULL rather than
 * the first element. Every read came back empty, which meant a tap could only
 * ever add — never remove, and never accumulate past the last one.
 *
 * Nothing in 1,154 passing tests could see that. This is the shape of test
 * that can: the statement is the thing being asserted, so a real database has
 * to run it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import { recordAnswer, type AskDeps } from "../../services/ask-question.ts";
import { isMultiAnswer } from "../../utils/ask-question.ts";

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[multi-answer] skipped — ${NO_DATABASE_MESSAGE}`);
}

const QUESTIONS = [
  { question: "Что включить?", multiSelect: true, options: [{ label: "тесты" }, { label: "линт" }, { label: "дубли" }] },
];

describeWithDb("toggling against a real database", () => {
  let db: TestDatabase;
  let deps: AskDeps;

  beforeAll(async () => {
    db = await provisionTestDatabase();
    deps = {
      sql: db.sql,
      sendMessage: async () => ({ ok: true, messageId: 1 }),
      editMessage: async () => ({ ok: true }),
    };
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** A fresh open request, with nothing chosen. */
  async function open(id: string): Promise<void> {
    await db.sql`
      INSERT INTO question_requests (id, session_id, chat_id, project_path, questions, answers, message_ids)
      VALUES (${id}, 1, '-100', '/tmp/p', ${db.sql.json(QUESTIONS as never)}, ${db.sql.json([null] as never)}, ${db.sql.json([700] as never)})
    `;
  }

  /** What the row holds for question 0. */
  async function picked(id: string): Promise<number[]> {
    const rows = await db.sql`SELECT answers FROM question_requests WHERE id = ${id}`;
    const slot = (rows[0]!.answers as unknown[])[0];
    return isMultiAnswer(slot) ? slot.picked : [];
  }

  test("a tap adds, a second tap on another option adds, and a third removes", async () => {
    // The whole cycle in one test, because the bug was not in any single step
    // — each read came back empty, so every step looked like the first one.
    const id = "mt000001";
    await open(id);

    await recordAnswer(deps, `ask:${id}:0:0`);
    expect(await picked(id)).toEqual([0]);

    await recordAnswer(deps, `ask:${id}:0:2`);
    expect(await picked(id)).toEqual([0, 2]);

    await recordAnswer(deps, `ask:${id}:0:0`);
    expect(await picked(id)).toEqual([2]);
  });

  test("toggling does not answer the question", async () => {
    const id = "mt000002";
    await open(id);

    await recordAnswer(deps, `ask:${id}:0:1`);

    const rows = await db.sql`SELECT answers, answered_at FROM question_requests WHERE id = ${id}`;
    expect(rows[0]!.answered_at).toBeNull();
    const slot = (rows[0]!.answers as unknown[])[0];
    expect(isMultiAnswer(slot) && slot.done).toBe(false);
  });

  test("submitting marks it done and keeps what was chosen", async () => {
    const id = "mt000003";
    await open(id);
    await recordAnswer(deps, `ask:${id}:0:1`);
    await recordAnswer(deps, `ask:${id}:0:2`);

    const outcome = await recordAnswer(deps, `ask:${id}:0:s`);

    expect(outcome).toEqual({ status: "recorded", label: "линт, дубли", complete: true });
    const rows = await db.sql`SELECT answers FROM question_requests WHERE id = ${id}`;
    const slot = (rows[0]!.answers as unknown[])[0];
    expect(isMultiAnswer(slot) && slot.done).toBe(true);
    expect(await picked(id)).toEqual([1, 2]);
  });

  test("submitting nothing is refused, and nothing is written", async () => {
    const id = "mt000004";
    await open(id);

    const outcome = await recordAnswer(deps, `ask:${id}:0:s`);

    expect(outcome.status).toBe("out-of-range");
    const rows = await db.sql`SELECT answers FROM question_requests WHERE id = ${id}`;
    expect((rows[0]!.answers as unknown[])[0]).toBeNull();
  });

  test("two taps on the same question do not overwrite one another", async () => {
    // The reason the toggle happens inside the statement. Read the array here,
    // change it and write it back, and each write carries the other's
    // selection as it was before — so one of the two taps is simply lost.
    const id = "mt000005";
    await open(id);

    await Promise.all([
      recordAnswer(deps, `ask:${id}:0:0`),
      recordAnswer(deps, `ask:${id}:0:1`),
    ]);

    expect((await picked(id)).sort()).toEqual([0, 1]);
  });

  test("a single-select question in the same row is still an index", async () => {
    // The two shapes live side by side in one answers array, and reading one
    // as the other is how a chosen option becomes "no answer".
    const id = "mt000006";
    await db.sql`
      INSERT INTO question_requests (id, session_id, chat_id, project_path, questions, answers, message_ids)
      VALUES (${id}, 1, '-100', '/tmp/p',
              ${db.sql.json([QUESTIONS[0], { question: "Куда?", multiSelect: false, options: [{ label: "staging" }] }] as never)},
              ${db.sql.json([null, null] as never)}, ${db.sql.json([700, 701] as never)})
    `;

    await recordAnswer(deps, `ask:${id}:0:1`);
    await recordAnswer(deps, `ask:${id}:1:0`);

    const rows = await db.sql`SELECT answers FROM question_requests WHERE id = ${id}`;
    const answers = rows[0]!.answers as unknown[];
    expect(isMultiAnswer(answers[0])).toBe(true);
    expect(answers[1]).toBe(0);
  });
});

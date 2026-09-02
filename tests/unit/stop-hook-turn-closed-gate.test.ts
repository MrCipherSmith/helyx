/**
 * AC6 (flow 065, T7) — the Stop-hook path must not publish `turn_closed`
 * when the Telegram send it just made failed.
 *
 * `mcp/server.ts`'s `deliverTurnSummary()` (~lines 326-397) sends the
 * forwarded summary and then, unconditionally, `pg_notify`s
 * `turn_closed_<sessionId>` so the status/response-guard machinery treats
 * the turn as over:
 *
 *   for (const part of summary.parts) {
 *     await deps.send(deps.token, target.chatId, part, { parse_mode: "HTML", ...target.extra });
 *   }
 *   ...
 *   await deps.sql`SELECT pg_notify(${`turn_closed_${target.sessionId}`}, ...)`.catch(() => {});
 *
 * `deps.send`'s return value is awaited but never inspected — there is no
 * `.ok` check anywhere in this function. If the Telegram send genuinely
 * fails, `turn_closed` still fires: the operator's chat is reported as
 * "answered" (the status closes, the response guard stops waiting) even
 * though nothing reached them.
 *
 * The target fix (flow 065's later task, T8 — NOT implemented here) checks
 * `.ok` on the send result and skips (or defers) publishing `turn_closed`
 * when it is false, per this flow's `description.md` P0-B scope. This test
 * drives the real `deliverTurnSummary` (the existing `TurnSummaryDeps` seam
 * `tests/unit/turn-summary-delivery.test.ts` already uses) with a `send`
 * stub that reports failure, and asserts no `turn_closed` notification goes
 * out. It fails today because nothing gates on `.ok` yet.
 *
 * FakeSql, matching `tests/unit/turn-summary-delivery.test.ts`'s own
 * convention for this exact function: `deliverTurnSummary` never touches
 * `pending_replies`, and the property under test (was pg_notify called) is
 * a query-shape question FakeSql answers correctly, not a real-timing
 * question that needs a real database.
 */

import { describe, test, expect } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { deliverTurnSummary, type TurnSummaryDeps } from "../../mcp/server.ts";

const PROJECT = "/home/altsay/bots/helyx";
const TOPIC = 1158;
const FORUM = "-1003908750902";

const line = (o: unknown) => JSON.stringify(o);
const operator = (text: string) => line({ type: "user", message: { content: text } });
const said = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });

function harness(sendResult: { ok: boolean; messageId?: number | null; errorBody?: string }) {
  const db = new FakeSql();
  db.program("FROM sessions s", {
    rows: [{
      session_id: 7,
      chat_id: "-100777",
      forum_topic_id: TOPIC,
      forum_chat_id: FORUM,
    }],
  });

  const deps: TurnSummaryDeps = {
    sql: db.sql as unknown as TurnSummaryDeps["sql"],
    token: "fake-token",
    read: () => [operator("go"), said("Done — all green.")].join("\n"),
    send: (async () => sendResult) as unknown as TurnSummaryDeps["send"],
    speak: () => {},
    now: () => 1_700_000_000_000,
  };

  return { deps, db };
}

describe("the Stop-hook's turn_closed gate on the Telegram send result (AC6, flow 065 T7)", () => {
  test("a failed send does not publish turn_closed as if delivery succeeded", async () => {
    const { deps, db } = harness({ ok: false, messageId: null, errorBody: "simulated Telegram failure" });

    await deliverTurnSummary("/tmp/t.jsonl", PROJECT, deps);

    // Target contract: deliverTurnSummary is expected to check `.ok` before
    // publishing `turn_closed`. Today it awaits `deps.send` and never reads
    // the result, so pg_notify fires unconditionally right after — this
    // fails against the unfixed code (db.count("pg_notify") reads 1, not 0).
    expect(db.count("pg_notify")).toBe(0);
  });
});

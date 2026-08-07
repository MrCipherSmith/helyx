/**
 * Loop 5b — summarising before Claude Code folds its own context.
 *
 * The arithmetic lives in `utils/context-usage.ts` and is tested there. What is
 * asserted here is the part only the loop can get wrong: which sessions it
 * looks at, that a busy one is left alone, and that a session parked above the
 * threshold is summarised once rather than every two minutes for as long as it
 * sits there.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { checkContextPressure, resetContextHighWater } from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

const SESSIONS_QUERY = "SELECT s.id";

/** One active session, in one chat, on a 200k model. */
function world(options: { busy?: boolean; model?: string | null } = {}) {
  const db = new FakeSql();
  db.program(SESSIONS_QUERY, {
    rows: [{
      session_id: 7,
      project_path: "/home/u/proj",
      model: options.model === undefined ? "claude-sonnet-4-20250514" : options.model,
      busy: options.busy ?? false,
      chat_id: "555",
    }],
  });
  return db;
}

/** Records what the loop asked for and what it decided to do. */
function spy(contextTokens: number | null) {
  const summarized: Array<{ sessionId: number; chatId: string }> = [];
  return {
    summarized,
    deps: {
      readContext: async () => contextTokens,
      summarize: async (sessionId: number, chatId: string) => {
        summarized.push({ sessionId, chatId });
      },
    },
  };
}

beforeEach(() => {
  resetContextHighWater();
});

describe("a session over the threshold", () => {
  test("is summarised when it is between turns", async () => {
    const db = world();
    const { deps, summarized } = spy(180_000);

    await checkContextPressure(db.sql as never, deps);

    expect(summarized).toEqual([{ sessionId: 7, chatId: "555" }]);
  });

  test("is left alone while it is working", async () => {
    // The fold is close, not immediate. Cutting into a turn to talk about it
    // would be its own defect.
    const db = world({ busy: true });
    const { deps, summarized } = spy(180_000);

    await checkContextPressure(db.sql as never, deps);

    expect(summarized).toEqual([]);
  });

  test("is summarised once, not once per tick", async () => {
    const db = world();
    const { deps, summarized } = spy(180_000);

    await checkContextPressure(db.sql as never, deps);
    await checkContextPressure(db.sql as never, deps);
    await checkContextPressure(db.sql as never, deps);

    expect(summarized).toHaveLength(1);
  });

  test("is summarised again when it grows past the mark", async () => {
    const db = world();
    const first = spy(180_000);
    await checkContextPressure(db.sql as never, first.deps);

    const second = spy(195_000);
    await checkContextPressure(db.sql as never, second.deps);

    expect(second.summarized).toHaveLength(1);
  });
});

describe("a session under the threshold", () => {
  test("is not summarised", async () => {
    const db = world();
    const { deps, summarized } = spy(100_000);

    await checkContextPressure(db.sql as never, deps);

    expect(summarized).toEqual([]);
  });

  test("a transcript with no usage yet is not a measurement of zero", async () => {
    const db = world();
    const { deps, summarized } = spy(null);

    await checkContextPressure(db.sql as never, deps);

    expect(summarized).toEqual([]);
  });
});

describe("what the loop tolerates", () => {
  test("a session with no chat bound to it is skipped, not crashed on", async () => {
    const db = new FakeSql();
    db.program(SESSIONS_QUERY, {
      rows: [{ session_id: 7, project_path: "/home/u/proj", model: null, busy: false, chat_id: null }],
    });
    const { deps, summarized } = spy(190_000);

    await checkContextPressure(db.sql as never, deps);

    expect(summarized).toEqual([]);
  });

  test("a summariser that throws does not stop the tick", async () => {
    const db = new FakeSql();
    db.program(SESSIONS_QUERY, {
      rows: [
        { session_id: 7, project_path: "/a", model: null, busy: false, chat_id: "1" },
        { session_id: 8, project_path: "/b", model: null, busy: false, chat_id: "2" },
      ],
    });
    const seen: number[] = [];
    const deps = {
      readContext: async () => 190_000,
      summarize: async (sessionId: number) => {
        seen.push(sessionId);
        if (sessionId === 7) throw new Error("aux model refused");
      },
    };

    await checkContextPressure(db.sql as never, deps);

    expect(seen).toEqual([7, 8]);
  });

  test("a transcript that cannot be read is not a measurement", async () => {
    const db = world();
    const summarized: number[] = [];
    await checkContextPressure(db.sql as never, {
      readContext: async () => { throw new Error("no such file"); },
      summarize: async (sessionId: number) => { summarized.push(sessionId); },
    });

    expect(summarized).toEqual([]);
  });
});

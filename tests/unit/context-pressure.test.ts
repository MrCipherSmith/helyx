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
import { checkContextPressure, resetContextHighWater, typeIntoSession } from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

const SESSIONS_QUERY = "SELECT s.id";

/** One active session, in one chat, on a 200k model. */
function world(options: { busy?: boolean; model?: string | null } = {}) {
  const db = new FakeSql();
  db.program(SESSIONS_QUERY, {
    rows: [{
      session_id: 7,
      project: "proj",
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
      readContext: async () => ({ tokens: contextTokens, window: null }),
      // Returns a summary, because `forceSummarize` returns `string | null`
       // and the loop now reads that return value. A mock that returned
       // undefined was claiming the summariser had declined.
      summarize: async (sessionId: number, chatId: string) => {
        summarized.push({ sessionId, chatId });
        return "a summary";
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
      readContext: async () => ({ tokens: 190_000, window: null }),
      summarize: async (sessionId: number) => {
        seen.push(sessionId);
        if (sessionId === 7) throw new Error("aux model refused");
        return "a summary";
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
      summarize: async (sessionId: number) => { summarized.push(sessionId); return "a summary"; },
    });

    expect(summarized).toEqual([]);
  });
});

describe("taking the fold instead of waiting for it", () => {
  /** A world plus a pane that records everything typed into it. */
  function withPane(contextTokens: number | null, window: number | null = null) {
    const typed: Array<{ project: string; keys: string }> = [];
    const summarized: number[] = [];
    return {
      typed,
      summarized,
      deps: {
        readContext: async () => ({ tokens: contextTokens, window }),
        summarize: async (sessionId: number) => { summarized.push(sessionId); return "a summary"; },
        sendKeys: async (project: string, keys: string) => { typed.push({ project, keys }); },
      },
    };
  }

  beforeEach(() => {
    resetContextHighWater();
    delete process.env.CONTEXT_AUTO_COMPACT;
  });

  test("types nothing at all while the flag is off", async () => {
    // The default. It writes into a live pane the operator may be looking at,
    // so it is opt-in and stays that way until someone says otherwise.
    const s = withPane(190_000);
    await checkContextPressure(world().sql as never, s.deps);
    expect(s.summarized).toEqual([7]);
    expect(s.typed).toEqual([]);
  });

  test("compacts right after the summary is written, not before", async () => {
    process.env.CONTEXT_AUTO_COMPACT = "true";
    const s = withPane(190_000, 200_000);
    await checkContextPressure(world().sql as never, s.deps);
    expect(s.summarized).toEqual([7]);
    expect(s.typed).toEqual([{ project: "proj", keys: "/compact" }]);
  });

  test("a failed summary means no fold", async () => {
    // Compacting after a failed summarise would discard exactly the material
    // the loop exists to preserve.
    process.env.CONTEXT_AUTO_COMPACT = "true";
    const typed: Array<{ project: string; keys: string }> = [];
    await checkContextPressure(world().sql as never, {
      readContext: async () => ({ tokens: 190_000, window: 200_000 }),
      summarize: async () => { throw new Error("summariser down"); },
      sendKeys: async (project: string, keys: string) => { typed.push({ project, keys }); },
    });
    expect(typed).toEqual([]);
  });

  test("a declined summary is retried, not recorded as done", async () => {
    // `forceSummarize` does not throw when it declines — it returns null on the
    // "low-quality summary output" path, which fired four times for one session
    // on 2026-08-08. The high-water mark used to be set before the call, so a
    // decline was remembered as a success: the session was never tried again at
    // that ratio, and the log said `summarized at 86.0%` for a session where
    // nothing had been written to memory.
    process.env.CONTEXT_AUTO_COMPACT = "true";
    const seen: number[] = [];
    const typed: Array<{ project: string; keys: string }> = [];
    const deps = {
      readContext: async () => ({ tokens: 190_000, window: 200_000 }),
      summarize: async (sessionId: number) => {
        seen.push(sessionId);
        return null;
      },
      sendKeys: async (project: string, keys: string) => { typed.push({ project, keys }); },
    };

    await checkContextPressure(world().sql as never, deps);
    await checkContextPressure(world().sql as never, deps);

    // Tried again on the next tick at the same ratio, rather than shut out by a
    // mark that recorded a summary nobody wrote.
    expect(seen.length).toBe(2);
    // And no fold: compacting after a declined summary discards exactly the
    // material the loop runs to preserve.
    expect(typed).toEqual([]);
  });

  test("a summary that failed once is retried at the same ratio", async () => {
    process.env.CONTEXT_AUTO_COMPACT = "true";
    const seen: number[] = [];
    let first = true;
    const deps = {
      readContext: async () => ({ tokens: 190_000, window: 200_000 }),
      summarize: async (sessionId: number) => {
        seen.push(sessionId);
        if (first) { first = false; throw new Error("summariser down"); }
        return "a summary";
      },
    };

    await checkContextPressure(world().sql as never, deps);
    await checkContextPressure(world().sql as never, deps);
    expect(seen.length).toBe(2);
  });

  test("a session that was summarised is not summarised again at the same ratio", async () => {
    // The other half of the same rule: a real success does hold the mark, so
    // the loop does not re-summarise the same crossing every two minutes.
    const seen: number[] = [];
    const deps = {
      readContext: async () => ({ tokens: 190_000, window: 200_000 }),
      summarize: async (sessionId: number) => { seen.push(sessionId); return "a summary"; },
    };

    await checkContextPressure(world().sql as never, deps);
    await checkContextPressure(world().sql as never, deps);
    expect(seen.length).toBe(1);
  });

  test("a session that came back down is summarised again on the next crossing", async () => {
    // The mark only ever rose, so "once per crossing" was really once per
    // session: summarised at 0.86, folded to 0.2, back to 0.86 — and 0.86 is
    // not greater than 0.86, so nothing happened. Each cycle served later than
    // the last, and a session that ever read full (usageRatio clamps at 1) was
    // never summarised again at all.
    const seen: number[] = [];
    let tokens = 190_000;
    const deps = {
      readContext: async () => ({ tokens, window: 200_000 }),
      summarize: async (sessionId: number) => { seen.push(sessionId); return "a summary"; },
    };

    await checkContextPressure(world().sql as never, deps);
    expect(seen.length).toBe(1);

    // The fold lands: back down to 20%.
    tokens = 40_000;
    await checkContextPressure(world().sql as never, deps);
    expect(seen.length).toBe(1);

    // And it fills again to the same ratio that was served before.
    tokens = 190_000;
    await checkContextPressure(world().sql as never, deps);
    expect(seen.length).toBe(2);
  });

  test("a session that never comes down is not re-summarised on noise", async () => {
    // The other side of the hysteresis: a reading wobbling just under the
    // threshold must not release the mark and re-fire every tick.
    const seen: number[] = [];
    let tokens = 190_000;
    const deps = {
      readContext: async () => ({ tokens, window: 200_000 }),
      summarize: async (sessionId: number) => { seen.push(sessionId); return "a summary"; },
    };

    await checkContextPressure(world().sql as never, deps);
    tokens = 168_000; // 84% — under the 85% threshold, but not under 75%
    await checkContextPressure(world().sql as never, deps);
    tokens = 190_000;
    await checkContextPressure(world().sql as never, deps);
    expect(seen.length).toBe(1);
  });

  test("the query still selects chat_id, and this test reads the SQL because no fixture can", async () => {
    // Flow 061 added four pulse columns *over* this subselect rather than
    // beside it. `row.chat_id` then read null for every session, the
    // `if (!chatId) continue` guard skipped every one, and the entire loop —
    // high-water release, decideCrossing, the /context ask, the summarise, the
    // fold — went silent. Silently: the log line that would have shown it only
    // prints for sessions that get past the guard.
    //
    // Every other test here hands `chat_id` back from the fixture, so all of
    // them passed with the column gone. The only way to catch it is to read the
    // statement the loop actually sends.
    const db = world();
    await checkContextPressure(db.sql as never, spy(1000).deps);

    const sent = db.queries.map((q) => q.text).find((t) => t.includes("SELECT s.id"));
    expect(sent).toBeDefined();
    expect(sent).toContain("AS chat_id");
  });

  test("asks an unknown session for its window, once", async () => {
    process.env.CONTEXT_AUTO_COMPACT = "true";
    const s = withPane(1000, null); // below the threshold; only the ask should happen
    await checkContextPressure(world().sql as never, s.deps);
    await checkContextPressure(world().sql as never, s.deps);
    expect(s.typed).toEqual([{ project: "proj", keys: "/context" }]);
    expect(s.summarized).toEqual([]);
  });

  test("does not ask a session that already reported its window", async () => {
    process.env.CONTEXT_AUTO_COMPACT = "true";
    const s = withPane(1000, 1_000_000);
    await checkContextPressure(world().sql as never, s.deps);
    expect(s.typed).toEqual([]);
  });

  test("never types into a busy session", async () => {
    // Mid-turn the pane is composing something; typing into it corrupts that.
    process.env.CONTEXT_AUTO_COMPACT = "true";
    const s = withPane(1000, null);
    await checkContextPressure(world({ busy: true }).sql as never, s.deps);
    expect(s.typed).toEqual([]);
  });
});

describe("what may be typed into a pane", () => {
  test("a project name that is not a plain window name is refused", async () => {
    // It arrives from a database column and everything after it is a command line.
    const calls: string[] = [];
    const shell = async (cmd: string) => { calls.push(cmd); return { ok: true, output: "" }; };
    for (const bad of ['proj"; rm -rf /', "proj; touch x", "$(whoami)", "a b"]) {
      await expect(typeIntoSession(shell as any, bad, "/compact")).rejects.toThrow(/refusing/);
    }
    expect(calls).toEqual([]);
  });

  test("only a bare slash command may be typed", async () => {
    const calls: string[] = [];
    const shell = async (cmd: string) => { calls.push(cmd); return { ok: true, output: "" }; };
    await expect(typeIntoSession(shell as any, "proj", "rm -rf /")).rejects.toThrow(/refusing/);
    await typeIntoSession(shell as any, "proj", "/compact");
    expect(calls).toEqual(['tmux send-keys -t "bots:proj" "/compact" Enter']);
  });
});

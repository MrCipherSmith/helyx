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
      readContext: async () => ({ tokens: 190_000, window: null }),
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
        summarize: async (sessionId: number) => { summarized.push(sessionId); },
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

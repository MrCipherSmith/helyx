/**
 * Recording stand-ins for what `memory/summarizer.ts` imports.
 *
 * The summarizer takes `sql`, the LLM client and both memory layers as module
 * imports rather than as parameters, so this replaces the modules rather than
 * injecting doubles. That is the one place a module mock is the honest tool —
 * the same reasoning `fake-telegram.ts` records — because the alternative is
 * threading four dependencies through production code to suit a test.
 *
 * A `fetch` stub was the obvious alternative and is worse: the LLM client picks
 * its transport from the environment, so a stub would cover whichever one this
 * machine happens to use and mean nothing on another.
 *
 * Restoring matters. `mock.module` is process-wide and `bun test` runs every
 * file in one process, so the values are snapshotted *before* the mock is
 * installed — a namespace captured afterwards reports the fakes, and restoring
 * from it would leave them in place for every later file.
 */

import { mock } from "bun:test";

const DB_MODULE = "../../memory/db.ts";
const CLIENT_MODULE = "../../claude/client.ts";
const LONG_TERM_MODULE = "../../memory/long-term.ts";
const SHORT_TERM_MODULE = "../../memory/short-term.ts";

export interface Remembered {
  type?: string;
  content?: string;
  projectPath?: string | null;
  sessionId?: number;
  [key: string]: unknown;
}

export class FakeMemoryDeps {
  /** Conversations the summarizer asked the model to compact. */
  readonly summarized: Array<{ role: string; content: string }[]> = [];
  /** Free-form prompts, from `extractProjectKnowledge` and `summarizeWork`. */
  readonly prompts: string[] = [];
  /** The system prompt each of those was asked with. */
  readonly systems: string[] = [];
  /** Everything written to long-term memory, in order. */
  readonly remembered: Remembered[] = [];
  /** Everything written through the deduplicating path. */
  readonly rememberedSmart: Remembered[] = [];
  /** Sessions whose short-term cache was read. */
  readonly cacheReads: Array<{ sessionId: number; chatId: string }> = [];

  /** What the model returns for a conversation. Replaceable per test. */
  summary: { summary: string; facts: string[] } = {
    summary: "Обсудили миграцию базы и договорились откатить последний шаг.",
    facts: ["Миграция v49 добавляет колонку reply_context"],
  };

  /** What the model returns for a free-form prompt. Replaceable per test. */
  response = "FACT: сессии живут в tmux\nFACT: канал стартует на хосте";

  /** Messages the short-term cache hands back. */
  cached: Array<{ role: string; content: string }> = [];

  texts(): string[] {
    return this.remembered.map((r) => String(r.content ?? ""));
  }
}

export async function installFakeMemoryDeps(
  db: { sql: unknown },
): Promise<{ deps: FakeMemoryDeps; restore: () => void }> {
  const realDb = { ...(await import("../../memory/db.ts")) };
  const realClient = { ...(await import("../../claude/client.ts")) };
  const realLongTerm = { ...(await import("../../memory/long-term.ts")) };
  const realShortTerm = { ...(await import("../../memory/short-term.ts")) };

  const deps = new FakeMemoryDeps();

  // `sql` too: the summarizer reads it from the module rather than taking it,
  // so a test that wanted to control the rows had no other way in.
  mock.module(DB_MODULE, () => ({ ...realDb, sql: db.sql }));

  mock.module(CLIENT_MODULE, () => ({
    ...realClient,
    summarizeConversation: async (messages: Array<{ role: string; content: string }>) => {
      deps.summarized.push(messages);
      return deps.summary;
    },
    // `generateResponse` takes a message list and a system prompt, not a
    // string. The recorded value is the text the summarizer actually asked
    // about, so a test can assert what was asked rather than that something
    // was.
    generateResponse: async (messages: Array<{ content?: unknown }>, system?: string) => {
      const text = Array.isArray(messages)
        ? messages.map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content))).join("\n")
        : String(messages);
      deps.prompts.push(text);
      deps.systems.push(system ?? "");
      return deps.response;
    },
  }));

  mock.module(LONG_TERM_MODULE, () => ({
    ...realLongTerm,
    remember: async (entry: Remembered) => { deps.remembered.push(entry); return 1; },
    // Shaped like the real one: callers read `.id` and `.action` off it.
    rememberSmart: async (entry: Remembered) => {
      deps.rememberedSmart.push(entry);
      return { id: deps.rememberedSmart.length, action: "inserted" as const };
    },
  }));

  mock.module(SHORT_TERM_MODULE, () => ({
    ...realShortTerm,
    getCachedMessages: async (sessionId: number, chatId: string) => {
      deps.cacheReads.push({ sessionId, chatId });
      return deps.cached;
    },
  }));

  return {
    deps,
    restore: () => {
      mock.module(DB_MODULE, () => ({ ...realDb }));
      mock.module(CLIENT_MODULE, () => ({ ...realClient }));
      mock.module(LONG_TERM_MODULE, () => ({ ...realLongTerm }));
      mock.module(SHORT_TERM_MODULE, () => ({ ...realShortTerm }));
    },
  };
}

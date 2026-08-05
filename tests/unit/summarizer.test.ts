/**
 * What the system decides to remember.
 *
 * `memory/summarizer.ts` compacts an idle session, extracts durable project
 * knowledge and writes both to long-term memory. It is also where defect D1 of
 * this programme lived: for weeks it resolved a host path inside a container,
 * logged "file not found" 4136 times and saved nothing, and the only thing that
 * noticed was a person reading the log for another reason.
 *
 * These drive the real functions with the real decisions in place. The
 * collaborators — the model, both memory layers — are replaced at the module
 * boundary, because that is how this module takes them.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeMemoryDeps, type FakeMemoryDeps } from "../fixtures/fake-memory-deps.ts";

let deps: FakeMemoryDeps;
let restore: () => void;
let summarizer: typeof import("../../memory/summarizer.ts");
let fake: FakeSql;

async function withRows(messages = realConversation, projectPath: string | null = "/home/altsay/bots/helyx") {
  fake = new FakeSql();
  fake.program("FROM messages", { rows: messages.map((m) => ({ ...m, created_at: new Date() })) });
  fake.program("FROM sessions", { rows: [{ project_path: projectPath }] });
  fake.program("FROM permission_requests", { rows: [] });
  ({ deps, restore } = await installFakeMemoryDeps(fake as unknown as { sql: unknown }));
  // Imported after the doubles are installed, so it binds to them.
  summarizer = await import("../../memory/summarizer.ts");
}

afterEach(() => {
  summarizer?.stopAllTimers();
  restore?.();
});

/** Enough messages to clear the "too few to bother" gate, and not chit-chat. */
const realConversation = [
  { role: "user", content: "Разберись, почему очередь стоит и сообщения не доставляются в топик" },
  { role: "assistant", content: "Нашёл: поллер падал на пустом forum_topic_id и молча выходил" },
  { role: "user", content: "Почини и добавь тест на этот случай" },
  { role: "assistant", content: "Готово: guard в poller.ts плюс тест на пустой topic" },
  { role: "user", content: "Проверь, что миграция применяется на чистой базе" },
  { role: "assistant", content: "Применяется, прогнал migrate на пустой схеме" },
];

describe("compacting a session", () => {
  test("a session with too little in it is left alone", async () => {
    // Three messages is not a conversation worth a model call, and calling one
    // anyway is how long-term memory fills with noise.
    await withRows(realConversation.slice(0, 3));

    expect(await summarizer.forceSummarize(1, "-100", null)).toBeNull();
    expect(deps.summarized).toEqual([]);
    expect(deps.remembered).toEqual([]);
  });

  test("a real conversation is summarized and written once", async () => {
    await withRows();

    const summary = await summarizer.forceSummarize(1, "-100", null);

    expect(summary).toContain("миграцию");
    expect(deps.summarized).toHaveLength(1);
    const written = deps.remembered.filter((r) => r.type === "summary");
    expect(written).toHaveLength(1);
    expect(written[0]!.projectPath).toBe("/home/altsay/bots/helyx");
  });

  test("a summary the triage rejects is not written", async () => {
    // The model answering with something empty or formulaic must not become a
    // memory: the check exists because it did.
    await withRows();
    deps.summary = { summary: "OK", facts: [] };

    expect(await summarizer.forceSummarize(1, "-100", null)).toBeNull();
    expect(deps.remembered).toEqual([]);
  });

  test("facts from a conversation are written as facts, beside the summary", async () => {
    // Two write paths, and they are not interchangeable: a conversation's facts
    // go through `remember` as type "fact", while durable project knowledge
    // goes through the deduplicating `rememberSmart`. Asserted because the
    // first version of this test assumed the wrong one.
    await withRows();
    deps.summary = {
      summary: "Разобрали доставку в топик и починили поллер, добавили тест на пустой topic.",
      facts: ["poller.ts падал на пустом forum_topic_id и молча выходил из цикла"],
    };

    await summarizer.forceSummarize(1, "-100", null);

    const facts = deps.remembered.filter((r) => r.type === "fact");
    expect(facts.map((r) => r.content)).toContain(
      "poller.ts падал на пустом forum_topic_id и молча выходил из цикла",
    );
    expect(deps.rememberedSmart).toEqual([]);
  });

  test("a fact too short to be worth keeping is filtered out", async () => {
    // Thirty characters is the floor: below it a "fact" is a fragment, and
    // long-term memory fills with things nobody can act on.
    await withRows();
    deps.summary = { summary: "Разобрали доставку в топик и починили поллер сегодня.", facts: ["ok"] };

    await summarizer.forceSummarize(1, "-100", null);

    expect(deps.remembered.filter((r) => r.type === "fact")).toEqual([]);
  });
});

describe("closing a work session", () => {
  test("a session with too little in it is not summarized at all", async () => {
    await withRows(realConversation.slice(0, 3));

    expect(await summarizer.summarizeWork(1)).toBe(false);
    expect(deps.prompts).toEqual([]);
    expect(deps.rememberedSmart).toEqual([]);
  });

  test("a real session is summarized and kept as project context", async () => {
    await withRows();
    deps.response = "Починили поллер, добавили тест, миграция применяется на чистой базе.";

    const ok = await summarizer.summarizeWork(1);

    expect(ok).toBe(true);
    const context = deps.rememberedSmart.filter((r) => r.type === "project_context");
    expect(context).toHaveLength(1);
    expect(String(context[0]!.content)).toContain("Починили поллер");
    expect(context[0]!.projectPath).toBe("/home/altsay/bots/helyx");
  });

  test("a model that answers with nothing falls back to the conversation itself", async () => {
    // The session is ending: something has to be kept, and the raw exchange is
    // worth more than nothing. Found here: the fallback covered a throw and a
    // timeout but not an empty answer, so an empty string was saved as the
    // session's entire project context.
    await withRows();
    deps.response = "";

    const ok = await summarizer.summarizeWork(1);

    expect(ok).toBe(true);
    const context = deps.rememberedSmart.filter((r) => r.type === "project_context");
    expect(context).toHaveLength(1);
    // The fallback carries the messages themselves, roles and all.
    expect(String(context[0]!.content)).toContain("Разберись, почему очередь стоит");
  });
});

describe("durable project knowledge", () => {
  test("without a project path there is nothing to attach knowledge to", async () => {
    await withRows();
    await summarizer.extractProjectKnowledge(1, null, "work summary", realConversation);

    expect(deps.prompts).toEqual([]);
    expect(deps.rememberedSmart).toEqual([]);
  });

  test("too short a session is not worth asking about", async () => {
    await withRows();
    await summarizer.extractProjectKnowledge(1, "/p", "work summary", realConversation.slice(0, 3));

    expect(deps.prompts).toEqual([]);
  });

  test("facts are extracted and saved as project knowledge", async () => {
    await withRows();
    deps.response = "sessions live in tmux windows\nthe channel process starts on the host";

    await summarizer.extractProjectKnowledge(7, "/home/altsay/bots/helyx", "work summary", realConversation);

    expect(deps.prompts).toHaveLength(1);
    expect(deps.prompts[0]).toContain("durable project knowledge");
    const contents = deps.rememberedSmart.map((r) => String(r.content));
    expect(contents).toContain("sessions live in tmux windows");
    expect(contents).toContain("the channel process starts on the host");
    expect(deps.rememberedSmart[0]!.projectPath).toBe("/home/altsay/bots/helyx");
  });

  test("an answer with nothing durable in it writes nothing", async () => {
    await withRows();
    deps.response = "";

    await summarizer.extractProjectKnowledge(7, "/p", "work summary", realConversation);

    expect(deps.rememberedSmart).toEqual([]);
  });
});

describe("the idle timer", () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let scheduled: number;
  let cleared: number;

  beforeEach(async () => {
    await withRows();
    scheduled = 0;
    cleared = 0;
    globalThis.setTimeout = ((_fn: () => void, _ms: number) => {
      scheduled++;
      return { id: scheduled } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => { cleared++; }) as unknown as typeof clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  test("touching a session schedules exactly one timer", () => {
    summarizer.touchIdleTimer(1, "-100", "/p");

    expect(scheduled).toBe(1);
    expect(cleared).toBe(0);
  });

  test("touching it again replaces the timer rather than adding one", () => {
    // Two timers for one session means two summaries, and the second one
    // summarizes a session that has already been compacted.
    summarizer.touchIdleTimer(1, "-100", "/p");
    summarizer.touchIdleTimer(1, "-100", "/p");

    expect(scheduled).toBe(2);
    expect(cleared).toBe(1);
  });

  test("different sessions keep their own timers", () => {
    summarizer.touchIdleTimer(1, "-100", "/p");
    summarizer.touchIdleTimer(2, "-100", "/p");

    expect(scheduled).toBe(2);
    expect(cleared).toBe(0);
  });

  test("stopping clears every timer that is still pending", () => {
    summarizer.touchIdleTimer(1, "-100", "/p");
    summarizer.touchIdleTimer(2, "-100", "/p");

    summarizer.stopAllTimers();

    expect(cleared).toBe(2);
  });
});

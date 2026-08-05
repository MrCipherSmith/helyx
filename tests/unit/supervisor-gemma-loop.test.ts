/**
 * The health analyst's loop, end to end with fakes.
 *
 * `checkGemmaHealth` is the one loop whose output is a model's opinion, and the
 * one most able to fail quietly: it collects a snapshot, asks a local model to
 * judge it, writes a heartbeat and alerts only when the answer is not "OK".
 * Every step of that can fail without anyone noticing, which is why each is
 * driven here rather than argued about.
 *
 * `scheduledReviewDeps` is the other half: the real-world wiring for Loop 11,
 * separated from the loop so the loop could be tested, and therefore never
 * tested itself.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { checkGemmaHealth, scheduledReviewDeps } from "../../scripts/supervisor.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Every outbound call answers this, whether it is Ollama or Telegram. */
function stubNetwork(body: unknown, ok = true): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return ok ? Response.json(body) : new Response("no", { status: 503 });
  }) as unknown as typeof fetch;
  return { calls };
}

function db(): FakeSql {
  const fake = new FakeSql();
  fake.program("FROM sessions", { rows: [] });
  fake.program("FROM active_status_messages", { rows: [] });
  fake.program("FROM message_queue", { rows: [] });
  fake.program("FROM process_health", { rows: [] });
  fake.program("FROM projects", { rows: [] });
  return fake;
}

const shell = async () => ({ ok: true, output: "helyx\thelyx-bot-1\tUp 2 hours (healthy)" });

describe("the health analyst loop", () => {
  test("a healthy verdict writes a heartbeat and says nothing to the operator", async () => {
    const { calls } = stubNetwork({ message: { content: "OK" } });
    const fake = db();

    await checkGemmaHealth(fake.sql as never, shell);

    // The model was asked, and nothing was sent to Telegram: the whole point of
    // a ten-minute analyst is that most of its runs are silent.
    expect(calls.some((u) => u.includes("/api/chat"))).toBe(true);
    expect(calls.some((u) => u.includes("api.telegram.org"))).toBe(false);
    expect(fake.count("INSERT INTO process_health")).toBeGreaterThan(0);
  });

  test("a model that will not answer does not take the loop down", async () => {
    // A refused request must read as healthy rather than as an incident: the
    // analyst going quiet is not evidence that the system is unwell.
    stubNetwork({}, false);
    const fake = db();

    await expect(checkGemmaHealth(fake.sql as never, shell)).resolves.toBeUndefined();
    expect(fake.count("INSERT INTO process_health")).toBeGreaterThan(0);
  });

  test("a snapshot that cannot be collected is reported, not thrown", async () => {
    stubNetwork({ message: { content: "OK" } });

    // A shell that throws is how "docker is gone" arrives here.
    await expect(
      checkGemmaHealth(db().sql as never, async () => { throw new Error("docker: not found"); }),
    ).resolves.toBeUndefined();
  });
});

describe("the wiring for the scheduled review", () => {
  test("state round-trips through bot_config", async () => {
    const fake = new FakeSql();
    fake.program("FROM bot_config", { rows: [{ value: JSON.stringify({ lastSeenHash: "abc" }) }] });
    const deps = scheduledReviewDeps(fake.sql as never, shell);

    expect(await deps.loadState()).toEqual({ lastSeenHash: "abc" });

    await deps.saveState({ lastSeenHash: "def", running: true });

    expect(fake.count("INSERT INTO bot_config")).toBe(1);
  });

  test("a stored value that is not JSON reads as empty rather than throwing", async () => {
    // The row is written by this code, so a broken value means something else
    // wrote it — and guessing is worse than starting over.
    const fake = new FakeSql();
    fake.program("FROM bot_config", { rows: [{ value: "{ not json" }] });

    expect(await scheduledReviewDeps(fake.sql as never, shell).loadState()).toEqual({});
  });

  test("a missing row reads as empty state", async () => {
    const fake = new FakeSql();
    fake.program("FROM bot_config", { rows: [] });

    expect(await scheduledReviewDeps(fake.sql as never, shell).loadState()).toEqual({});
  });

  test("the branch comes from git, trimmed", async () => {
    const fake = new FakeSql();
    const deps = scheduledReviewDeps(fake.sql as never, async () => ({ ok: true, output: "feat/x\n" }));

    expect(await deps.branch()).toBe("feat/x");
  });
});

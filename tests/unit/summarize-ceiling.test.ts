/**
 * The summary ceiling, held against the measurement it came from.
 *
 * The local summarizer had a 30s cap chosen when `SUMMARIZE_MODEL` pointed at
 * gemma4:e2b, which made it in 17s. The bigger gemma4:e4b — the model the host
 * runs for everything else, and the one that survives the *other* two
 * `SUMMARIZE_MODEL` call sites — needs 35s warm and about 60s from cold. Under
 * the old cap it did not produce a slow summary; it aborted into the paid cloud
 * model on every single call, silently, because the whole block is wrapped in a
 * catch that falls through.
 *
 * So the cap is not a taste question and a round number is not an argument. It
 * has to clear a cold load plus a full-length generation at the slowest rate
 * anyone measured, and that is arithmetic a test can check. Lower it below what
 * the model needs and this fails — which is the point.
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { CONFIG } from "../../config.ts";
import {
  summarizeConversation,
  SUMMARIZE_TIMEOUT_MS,
  SUMMARIZE_NUM_PREDICT,
  SUMMARIZE_COLD_LOAD_MS,
  SUMMARIZE_SLOWEST_TOKENS_PER_SEC,
} from "../../claude/client.ts";
import { MANUAL_SUMMARIZE_TIMEOUT_MS, FOLD_SUMMARIZE_TIMEOUT_MS } from "../../memory/summarizer.ts";

/** Cold load, then every token of a maximum-length answer at the floor rate. */
function worstCaseMs(): number {
  return SUMMARIZE_COLD_LOAD_MS + (SUMMARIZE_NUM_PREDICT / SUMMARIZE_SLOWEST_TOKENS_PER_SEC) * 1000;
}

describe("the local summarizer's ceiling", () => {
  test("clears a cold load plus a full-length answer at the slowest measured rate", () => {
    expect(SUMMARIZE_TIMEOUT_MS).toBeGreaterThan(worstCaseMs());
  });

  test("keeps a third of the worst case as headroom, since prompt eval is not in the arithmetic", () => {
    // A long conversation spends seconds tokenising before the first token; 428
    // input tokens cost 210ms and the summarizer is handed whole sessions. The
    // margin is a fraction rather than a fixed 5s so that raising num_predict —
    // which raises the worst case — has to raise the ceiling with it. Raised in
    // review: at num_predict 600 a flat 5s still passed on a longer answer where
    // prompt eval matters more.
    expect(SUMMARIZE_TIMEOUT_MS - worstCaseMs()).toBeGreaterThan(worstCaseMs() / 3);
  });

  test("the old 30s cap would not have cleared it — the regression this guards", () => {
    expect(30_000).toBeLessThan(worstCaseMs());
  });

  test("the ceiling is not so generous that a wedged Ollama holds the path for minutes", () => {
    // The call falls through to the cloud model on abort, so a long wait costs a
    // delayed summary, not a lost one. Two minutes is where that stops being true.
    expect(SUMMARIZE_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  test("the callers with a deadline of their own stay under it", () => {
    // The raise is justified by "nobody is watching", so the paths where somebody
    // is must not inherit it. Both were found in review.
    expect(MANUAL_SUMMARIZE_TIMEOUT_MS).toBeLessThan(SUMMARIZE_TIMEOUT_MS);
    // The fold is raced against 15s in mcp/server.ts and must leave the cloud
    // fallback room to answer inside that.
    expect(FOLD_SUMMARIZE_TIMEOUT_MS).toBeLessThan(15_000 / 2);
  });
});

describe("the constants reach the request", () => {
  const realFetch = globalThis.fetch;
  // CONFIG binds at import, so the Ollama branch is chosen by the machine's
  // environment unless a test says otherwise — which is why these two passed
  // locally and failed in CI, where SUMMARIZE_MODEL is empty and the function
  // goes straight to the cloud path. Same approach as summary-normalize.test.ts:
  // `as const` on CONFIG is compile-time only, the fields are writable.
  const mutable = CONFIG as unknown as Record<string, unknown>;
  let previousModel: unknown;
  let previousUrl: unknown;

  beforeEach(() => {
    previousModel = mutable.SUMMARIZE_MODEL;
    previousUrl = mutable.OLLAMA_URL;
    mutable.SUMMARIZE_MODEL = "test-summarizer";
    mutable.OLLAMA_URL = "http://ollama.test";
  });

  afterEach(() => {
    mutable.SUMMARIZE_MODEL = previousModel;
    mutable.OLLAMA_URL = previousUrl;
    globalThis.fetch = realFetch;
  });

  /** Capture the Ollama request body the summarizer actually sends. */
  async function bodyOf(opts?: { timeoutMs?: number }): Promise<any> {
    let sent: any = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ message: { content: JSON.stringify({ summary: "s", facts: [] }) } });
    }) as unknown as typeof fetch;
    await summarizeConversation([{ role: "user", content: "hi" }], opts);
    return sent;
  }

  test("num_predict on the wire is the constant, not a literal beside it", async () => {
    // Without this, reverting the call site to a hard-coded 30_000 leaves every
    // arithmetic test above green — they only compare constants to each other.
    // Raised in review.
    expect((await bodyOf()).options.num_predict).toBe(SUMMARIZE_NUM_PREDICT);
  });

  test("a caller's own ceiling is the one that aborts the call", async () => {
    let aborted = false;
    let call = 0;
    globalThis.fetch = ((_url: string, init: any) => {
      // Only the first call is the local summariser. The abort sends the
      // function on to the cloud path, which must fail immediately rather than
      // hang on this same stub — 400 is not retried, so the fallthrough is fast.
      if (++call > 1) return Promise.resolve(new Response("no", { status: 400 }));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;

    await summarizeConversation([{ role: "user", content: "hi" }], { timeoutMs: 40 }).catch(() => {});

    expect(aborted).toBe(true);
  });
});

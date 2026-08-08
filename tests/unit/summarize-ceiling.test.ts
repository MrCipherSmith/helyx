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

import { describe, test, expect } from "bun:test";
import {
  SUMMARIZE_TIMEOUT_MS,
  SUMMARIZE_NUM_PREDICT,
  SUMMARIZE_COLD_LOAD_MS,
  SUMMARIZE_SLOWEST_TOKENS_PER_SEC,
} from "../../claude/client.ts";

/** Cold load, then every token of a maximum-length answer at the floor rate. */
function worstCaseMs(): number {
  return SUMMARIZE_COLD_LOAD_MS + (SUMMARIZE_NUM_PREDICT / SUMMARIZE_SLOWEST_TOKENS_PER_SEC) * 1000;
}

describe("the local summarizer's ceiling", () => {
  test("clears a cold load plus a full-length answer at the slowest measured rate", () => {
    expect(SUMMARIZE_TIMEOUT_MS).toBeGreaterThan(worstCaseMs());
  });

  test("clears it with room to spare, since prompt eval is not in the arithmetic", () => {
    // A long conversation spends seconds tokenising before generation starts;
    // 428 input tokens cost 210ms, but the summarizer is handed whole sessions.
    expect(SUMMARIZE_TIMEOUT_MS - worstCaseMs()).toBeGreaterThan(5_000);
  });

  test("the old 30s cap would not have cleared it — the regression this guards", () => {
    expect(30_000).toBeLessThan(worstCaseMs());
  });

  test("the ceiling is not so generous that a wedged Ollama holds the path for minutes", () => {
    // The call falls through to the cloud model on abort, so a long wait costs a
    // delayed summary, not a lost one. Two minutes is where that stops being true.
    expect(SUMMARIZE_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  test("the measurements are stated as real figures, not placeholders", () => {
    expect(SUMMARIZE_COLD_LOAD_MS).toBeGreaterThan(0);
    expect(SUMMARIZE_SLOWEST_TOKENS_PER_SEC).toBeGreaterThan(0);
    expect(SUMMARIZE_NUM_PREDICT).toBeGreaterThan(0);
  });
});

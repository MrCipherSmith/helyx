/**
 * How full the window is, and whether that is worth acting on.
 *
 * The arithmetic is here rather than in the loop for one reason: every
 * interesting case — an unknown model, a transcript with no usage yet, a
 * session sitting at the threshold for an hour — is a function of its inputs,
 * and none of them need a database, a transcript on disk, or a supervisor tick
 * to reach.
 */

import { describe, test, expect } from "bun:test";
import {
  contextTokens,
  decideCrossing,
  DEFAULT_CONTEXT_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  isKnownModel,
  newestContextTokens,
  usageRatio,
  windowFor,
} from "../../utils/context-usage.ts";

/** The shape measured on this repository's own session, to the token. */
const REAL_USAGE = {
  message: {
    usage: { input_tokens: 2, cache_creation_input_tokens: 1113, cache_read_input_tokens: 610_456 },
  },
};

describe("what the transcript says the context is", () => {
  test("sums what was sent, read from cache, and written to it", () => {
    expect(contextTokens(REAL_USAGE)).toBe(611_571);
  });

  test("an entry with no usage is not a measurement of zero", () => {
    // The distinction the loop depends on: most transcript lines carry no
    // usage, and treating them as 0% would summarise nothing, forever.
    expect(contextTokens({ message: { role: "user", content: "hi" } })).toBeNull();
    expect(contextTokens({})).toBeNull();
    expect(contextTokens(null)).toBeNull();
  });

  test("a partial usage block counts what is there", () => {
    expect(contextTokens({ message: { usage: { input_tokens: 500 } } })).toBe(500);
  });

  test("nonsense values are ignored rather than summed", () => {
    expect(contextTokens({ message: { usage: { input_tokens: -1, cache_read_input_tokens: "many" } } }))
      .toBeNull();
  });
});

describe("reading the tail", () => {
  const line = (usage: unknown) => JSON.stringify({ type: "assistant", message: { usage } });

  test("takes the newest entry that carries a measurement", () => {
    const lines = [
      line({ input_tokens: 10 }),
      JSON.stringify({ type: "user", message: { role: "user", content: "x" } }),
      line({ input_tokens: 900, cache_read_input_tokens: 100 }),
      JSON.stringify({ type: "user", message: { role: "user", content: "y" } }),
    ];
    expect(newestContextTokens(lines)).toBe(1000);
  });

  test("a cut first line is skipped, not fatal", () => {
    // The tail starts mid-file, so the first line is usually half an entry.
    expect(newestContextTokens(['{"message":{"usa', line({ input_tokens: 7 })])).toBe(7);
  });

  test("no measurement anywhere is null", () => {
    expect(newestContextTokens(["{}", "not json"])).toBeNull();
  });
});

describe("the denominator", () => {
  test("knows a model by prefix, so a date suffix does not lose it", () => {
    expect(windowFor("claude-sonnet-4-20250514")).toBe(200_000);
    expect(windowFor("claude-sonnet-4-5-20250929")).toBe(1_000_000);
    expect(isKnownModel("claude-sonnet-4-20250514")).toBe(true);
  });

  test("an unknown model falls back to the documented default, not a guess", () => {
    expect(windowFor("some-model-nobody-mapped")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(windowFor(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(isKnownModel("some-model-nobody-mapped")).toBe(false);
  });

  test("a ratio cannot exceed one, and a zero window is not a division", () => {
    expect(usageRatio(300_000, 200_000)).toBe(1);
    expect(usageRatio(100, 0)).toBe(0);
  });
});

describe("whether this tick summarises", () => {
  const base = {
    model: "claude-sonnet-4-20250514",
    threshold: DEFAULT_CONTEXT_THRESHOLD,
    idle: true,
    highWaterRatio: 0,
  };

  test("crosses when idle and above the threshold", () => {
    const d = decideCrossing({ ...base, contextTokens: 180_000 });
    expect(d.summarize).toBe(true);
    expect(d.reason).toBe("crossed");
    expect(d.window).toBe(200_000);
    expect(d.ratio).toBeCloseTo(0.9, 5);
  });

  test("below the threshold does nothing and says so", () => {
    const d = decideCrossing({ ...base, contextTokens: 100_000 });
    expect(d.summarize).toBe(false);
    expect(d.reason).toBe("below-threshold");
  });

  test("a busy session at the threshold is left for the next tick", () => {
    const d = decideCrossing({ ...base, contextTokens: 180_000, idle: false });
    expect(d.summarize).toBe(false);
    expect(d.reason).toBe("busy");
  });

  test("once per crossing, not once per tick", () => {
    // A session parked at 90% is one crossing. The loop runs every two minutes;
    // without this it would summarise thirty times an hour.
    const d = decideCrossing({ ...base, contextTokens: 180_000, highWaterRatio: 0.9 });
    expect(d.summarize).toBe(false);
    expect(d.reason).toBe("already-summarized");
  });

  test("growth past the mark is a new crossing", () => {
    const d = decideCrossing({ ...base, contextTokens: 190_000, highWaterRatio: 0.9 });
    expect(d.summarize).toBe(true);
  });

  test("no measurement is not a crossing, whatever else is true", () => {
    const d = decideCrossing({ ...base, contextTokens: null });
    expect(d.summarize).toBe(false);
    expect(d.reason).toBe("no-usage");
    expect(d.ratio).toBe(0);
  });

  test("an unknown model still decides, against the default window", () => {
    const d = decideCrossing({ ...base, model: "mystery-1", contextTokens: 180_000 });
    expect(d.window).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(d.summarize).toBe(true);
  });

  test("the threshold is not 98% — 90% of a window is already a crossing", () => {
    // The operator's first instinct was 98%. At that point there is no room to
    // summarise and Claude Code has usually folded already.
    expect(DEFAULT_CONTEXT_THRESHOLD).toBeLessThan(0.95);
    expect(decideCrossing({ ...base, contextTokens: 180_000 }).summarize).toBe(true);
  });
});

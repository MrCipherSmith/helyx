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
  contextThreshold,
  contextTokens,
  decideCrossing,
  DEFAULT_CONTEXT_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  isKnownModel,
  newestContextReport,
  parseContextReport,
  resolveWindow,
  newestContextTokens,
  usageRatio,
  knownModelPrefixes,
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
    expect(windowFor("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(isKnownModel("claude-sonnet-4-20250514")).toBe(true);
  });

  test("the models this deployment actually runs have their real window", () => {
    // Not a formality: every project here is on one of the first two. Reading
    // a 1M window as 200k overstates the ratio fivefold, and the 85% trigger
    // then fires at a seventh of the real usage, on every session, forever.
    expect(windowFor("claude-opus-5")).toBe(1_000_000);
    expect(windowFor("claude-sonnet-5")).toBe(1_000_000);
  });

  test("a longer prefix wins over a shorter one that would swallow it", () => {
    // The bug this table shipped with. `claude-opus-4` sat above
    // `claude-opus-4-8` and matched first, so a 1M model got a 200k
    // denominator — and nothing said so, because a wrong window is a wrong
    // percentage, not an error.
    expect(windowFor("claude-opus-4-8")).toBe(1_000_000);
    expect(windowFor("claude-opus-4-7")).toBe(1_000_000);
    expect(windowFor("claude-opus-4-6")).toBe(1_000_000);
    expect(windowFor("claude-sonnet-4-6")).toBe(1_000_000);
    // …and the shorter prefixes still resolve for the models that need them.
    expect(windowFor("claude-opus-4-5")).toBe(200_000);
    expect(windowFor("claude-opus-4-1-20250805")).toBe(200_000);
    expect(windowFor("claude-haiku-4-5")).toBe(200_000);
  });

  test("no entry is shadowed by an earlier one", () => {
    // Guards the ordering rule itself rather than the ids: a future addition
    // placed above its own longer sibling reintroduces the same silent bug.
    const prefixes = knownModelPrefixes();
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = i + 1; j < prefixes.length; j++) {
        expect(
          prefixes[j]!.startsWith(prefixes[i]!) ? `${prefixes[j]} is shadowed by ${prefixes[i]}` : "ok",
        ).toBe("ok");
      }
    }
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

describe("the threshold, read once for two processes", () => {
  test("an absent or unparseable value is the documented default", () => {
    for (const raw of [undefined, null, "", "  ", "abc"]) {
      expect(contextThreshold(raw)).toBe(DEFAULT_CONTEXT_THRESHOLD);
    }
  });

  test("an out-of-range value clamps rather than taking a process down", () => {
    // config.ts used to validate this range and exit(1) on a miss, while the
    // supervisor clamped. The same operator typo took the bot container down
    // and left the supervisor running at 0.5 — one setting, two behaviours.
    expect(contextThreshold("0.1")).toBe(0.5);
    expect(contextThreshold("1.5")).toBe(0.99);
    expect(contextThreshold(-3)).toBe(DEFAULT_CONTEXT_THRESHOLD);
  });

  test("a value in range is used as given", () => {
    expect(contextThreshold("0.7")).toBeCloseTo(0.7, 5);
    expect(contextThreshold(0.92)).toBeCloseTo(0.92, 5);
  });
});

describe("asking Claude Code for the window", () => {
  /** The shape of a real `/context` entry, taken from an actual invocation. */
  const REPORT = [
    "## Context Usage",
    "",
    "**Model:** claude-opus-5[1m]  ",
    "**Tokens:** 0 / 1m (0%)",
    "",
    "### MCP Tools",
    "| Tool | Server | Tokens |",
  ].join("\n");

  test("reads the model, the used tokens and the window", () => {
    expect(parseContextReport(REPORT)).toEqual({ model: "claude-opus-5[1m]", used: 0, window: 1_000_000 });
  });

  test("understands the units Claude Code prints", () => {
    const at = (used: string, win: string) =>
      parseContextReport(`## Context Usage\n**Model:** m\n**Tokens:** ${used} / ${win} (1%)`);
    expect(at("45.2k", "200k")).toEqual({ model: "m", used: 45_200, window: 200_000 });
    expect(at("1,500", "128k")).toEqual({ model: "m", used: 1_500, window: 128_000 });
    expect(at("3m", "1m")).toEqual({ model: "m", used: 3_000_000, window: 1_000_000 });
  });

  test("anything that is not a report is null, not a partial read", () => {
    // This value overrides the table, so a half-parse is a wrong denominator
    // everywhere rather than a missing one in one place.
    expect(parseContextReport("## Context Usage\n(no numbers here)")).toBeNull();
    expect(parseContextReport("an ordinary assistant message")).toBeNull();
    expect(parseContextReport({ not: "a string" })).toBeNull();
    expect(parseContextReport("## Context Usage\n**Model:** m\n**Tokens:** 5 / 0 (0%)")).toBeNull();
  });

  test("finds the newest report in a transcript tail", () => {
    const line = (content: string) => JSON.stringify({ type: "user", message: { content } });
    const lines = [
      line("## Context Usage\n**Model:** old\n**Tokens:** 1k / 200k (1%)"),
      line("something else"),
      line("## Context Usage\n**Model:** new\n**Tokens:** 2k / 1m (1%)"),
      "{ not json",
    ];
    expect(newestContextReport(lines)?.window).toBe(1_000_000);
    expect(newestContextReport([line("nothing")])).toBeNull();
  });

  test("a learned window beats the table, and its absence falls back to it", () => {
    expect(resolveWindow(1_000_000, "glm-5.2")).toBe(1_000_000);
    expect(resolveWindow(null, "claude-opus-5")).toBe(1_000_000);
    expect(resolveWindow(0, "some-unknown-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("the crossing decision divides by the learned window when there is one", () => {
    // The point of the whole mechanism: a model the table has never heard of
    // still gets a true percentage.
    const d = decideCrossing({
      contextTokens: 900_000,
      model: "glm-5.2",
      learnedWindow: 1_000_000,
      threshold: DEFAULT_CONTEXT_THRESHOLD,
      idle: true,
      highWaterRatio: 0,
    });
    expect(d.window).toBe(1_000_000);
    expect(d.ratio).toBeCloseTo(0.9, 5);
    expect(d.summarize).toBe(true);
  });
});

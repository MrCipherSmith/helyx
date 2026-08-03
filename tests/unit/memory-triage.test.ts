/**
 * What is worth remembering.
 *
 * These two heuristics are the most consequential unwatched code in the
 * project. A wrong "this is trivial" drops a conversation with no summary and
 * tells nobody — and the absence is indistinguishable from never having
 * discussed it at all. The failure is silent by construction, which is exactly
 * why it needs a test rather than an eye.
 */

import { describe, test, expect } from "bun:test";
import {
  isContentTrivial,
  isSummaryWorthSaving,
  timerKey,
  TRIVIAL_AVG_LENGTH,
  SUBSTANTIAL_LENGTH,
  MIN_SUMMARY_LENGTH,
} from "../../utils/memory-triage.ts";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

/** Long enough to count as substantial, and recognisable in a failure message. */
const substantial = (n: number) => user(`substantial message number ${n} with real content here`);

describe("isContentTrivial", () => {
  test("a real exchange is kept", () => {
    expect(isContentTrivial([substantial(1), substantial(2)])).toBe(false);
  });

  test("acknowledgements are dropped", () => {
    expect(isContentTrivial([user("ok"), user("thanks"), user("yep")])).toBe(true);
  });

  test("only the user's messages count", () => {
    // The assistant's output is not evidence that anything was discussed —
    // it will happily produce paragraphs about nothing.
    expect(
      isContentTrivial([user("ok"), assistant("a".repeat(500)), user("thanks")]),
    ).toBe(true);
  });

  test("a single message is always trivial, however long", () => {
    // Pinned rather than fixed. "Deploying needs the migration run first, and
    // never with the cache warm" is one message and is discarded whole. It is a
    // real risk, and changing it is a decision about how much noise the memory
    // should carry — not something to slip in under a test pass.
    expect(isContentTrivial([user("x".repeat(500))])).toBe(true);
    expect(isContentTrivial([])).toBe(true);
    expect(isContentTrivial([assistant("x".repeat(500))])).toBe(true);
  });

  test("one long message beside a short one is not enough", () => {
    // Two substantial messages are required, so a fact stated once and
    // acknowledged does not survive either.
    expect(isContentTrivial([substantial(1), user("ok")])).toBe(true);
  });

  test("the average threshold decides on its own, and at the boundary", () => {
    // Constructed so that only the average rule can be the one deciding: both
    // sets have two substantial messages, so the substantial rule says keep.
    // The first version of this test used two short messages, which the
    // substantial rule also rejected — so it would have passed with `<` changed
    // to `<=`, or with the average rule deleted entirely.
    const long = () => user("x".repeat(SUBSTANTIAL_LENGTH));
    const tiny = () => user("x");

    // Two long, eight tiny: sum 88 over 10 messages — 8.8, below the threshold.
    const belowAverage = [long(), long(), ...Array.from({ length: 8 }, tiny)];
    expect(isContentTrivial(belowAverage)).toBe(true);

    // Two long, one tiny: sum 81 over 3 — 27, above it. Same substantial count.
    const aboveAverage = [long(), long(), tiny()];
    expect(isContentTrivial(aboveAverage)).toBe(false);

    // And the threshold itself is where it says: 40 + 40 + 10 over 3 is exactly 30,
    // while dropping to 15 gives 31.6 — both above. Pin the constant instead.
    expect(TRIVIAL_AVG_LENGTH).toBe(25);
  });

  test("the substantial threshold is what it says", () => {
    const long = "x".repeat(SUBSTANTIAL_LENGTH);
    const short = "x".repeat(SUBSTANTIAL_LENGTH - 1);
    expect(isContentTrivial([user(long), user(long)])).toBe(false);
    expect(isContentTrivial([user(short), user(short)])).toBe(true);
  });

  test("whitespace is not content", () => {
    // Padding a short message with spaces must not buy it past the threshold.
    expect(isContentTrivial([user(`ok${" ".repeat(100)}`), user(`sure${" ".repeat(100)}`)])).toBe(true);
  });

  test("a long conversation of short messages is still chit-chat", () => {
    const many = Array.from({ length: 40 }, () => user("ok"));
    expect(isContentTrivial(many)).toBe(true);
  });
});

describe("isSummaryWorthSaving", () => {
  const real =
    "The deploy pipeline needs the migration applied before the container restarts, " +
    "otherwise the bot starts against an older schema and the queue reader skips rows.";

  test("a real summary is kept", () => {
    expect(isSummaryWorthSaving(real)).toBe(true);
  });

  test("too short is not a summary, and the boundary is exact", () => {
    // Both sides. Testing only the short one leaves `<` free to become `<=`,
    // which would silently reject every summary of exactly the minimum length.
    expect(isSummaryWorthSaving("x".repeat(MIN_SUMMARY_LENGTH - 1))).toBe(false);
    expect(isSummaryWorthSaving("x".repeat(MIN_SUMMARY_LENGTH))).toBe(true);
    expect(isSummaryWorthSaving("")).toBe(false);
    expect(isSummaryWorthSaving("   ")).toBe(false);
  });

  test("a model reporting emptiness is refused", () => {
    // A bad summary saved is a wrong fact recalled with confidence, which is
    // worse than no fact at all — so this side is allowed to be strict.
    for (const empty of [
      "Nothing significant was discussed in this conversation between the two parties.",
      "This was a casual conversation with no particular topic worth recording here.",
      "No tasks were assigned and no code was written during this exchange at all.",
      "There were no changes made to the repository during this working session.",
    ]) {
      expect([empty.slice(0, 30), isSummaryWorthSaving(empty)]).toEqual([empty.slice(0, 30), false]);
    }
  });

  test("an acknowledgement is refused only when it opens the summary", () => {
    // Anchored deliberately: a summary that *begins* "ok" is an
    // acknowledgement, while a summary that merely mentions the word is not.
    expect(isSummaryWorthSaving(`ok, ${real}`)).toBe(false);
    expect(isSummaryWorthSaving(`The operator said ok to the plan. ${real}`)).toBe(true);
  });

  test("a summary that happens to mention no tasks in passing is refused", () => {
    // The unanchored patterns are broad on purpose, and this is the cost:
    // a real summary containing "no changes" is thrown away. Recorded so the
    // trade is visible rather than surprising.
    expect(isSummaryWorthSaving(`${real} There were no changes to the schema.`)).toBe(false);
  });

  test("leading whitespace does not smuggle an empty summary through", () => {
    expect(isSummaryWorthSaving(`   \n  Nothing important happened in this long conversation today.`)).toBe(false);
  });
});

describe("timerKey", () => {
  test("session and chat together", () => {
    // Keyed by session alone, the last chat to speak would cancel every other
    // chat's pending summary — and each of those is a conversation that then
    // leaves no trace.
    expect(timerKey(7, "-100123")).toBe("7:-100123");
    expect(timerKey(7, "-100123")).not.toBe(timerKey(7, "-100999"));
    expect(timerKey(7, "-100123")).not.toBe(timerKey(8, "-100123"));
  });
});

describe("buildWorkSessionPrompt", () => {
  test("both halves of the session reach the prompt", async () => {
    const { buildWorkSessionPrompt } = await import("../../memory/summarizer.ts");
    const prompt = buildWorkSessionPrompt(
      [{ role: "user", content: "why did the deploy fail?" }],
      [{ tool: "Bash", description: "docker compose logs", response: "exit 137" }],
    );

    expect(prompt).toContain("why did the deploy fail?");
    expect(prompt).toContain("[Bash] docker compose logs");
    expect(prompt).toContain("exit 137");
  });

  test("a long message is truncated at 500, and a tool response harder at 200", async () => {
    // The prompt has a token budget, and one runaway `cat` of a lockfile would
    // otherwise crowd out the conversation it is supposed to summarise.
    //
    // Distinct filler per side, because the same character on both proves only
    // the larger cap: a response limit changed from 200 to 499 would have
    // passed the first version of this test.
    const { buildWorkSessionPrompt } = await import("../../memory/summarizer.ts");
    const prompt = buildWorkSessionPrompt(
      [{ role: "user", content: "m".repeat(900) }],
      [{ tool: "Read", description: "package-lock.json", response: "r".repeat(900) }],
    );

    expect(prompt).toContain("m".repeat(500));
    expect(prompt).not.toContain("m".repeat(501));
    expect(prompt).toContain("r".repeat(200));
    expect(prompt).not.toContain("r".repeat(201));
  });

  test("a tool call with no response reads as a call, not as an empty result", async () => {
    const { buildWorkSessionPrompt } = await import("../../memory/summarizer.ts");
    const prompt = buildWorkSessionPrompt([], [{ tool: "Edit", description: "cli.ts", response: null }]);

    expect(prompt).toContain("[Edit] cli.ts");
    expect(prompt).not.toContain("cli.ts →");
  });

  test("the section headers the extractor parses are present", async () => {
    // The prompt and whatever reads its output have to agree about these, and
    // they agree by being written once.
    const { buildWorkSessionPrompt } = await import("../../memory/summarizer.ts");
    const prompt = buildWorkSessionPrompt([], []);

    for (const section of ["[DECISIONS]", "[FILES]", "[PROBLEMS]", "[PENDING]", "[CONTEXT]"]) {
      expect([section, prompt.includes(section)]).toEqual([section, true]);
    }
  });
});

/**
 * The status message the operator actually reads.
 *
 * It is the only window into a session for someone who does not watch the
 * terminal, and until now the rendering could only be reached by having a
 * session produce output — so the thing most looked at was the thing least
 * tested.
 */

import { describe, test, expect } from "bun:test";
import {
  renderStatus,
  renderFinal,
  renderStats,
  tailWithinBudget,
  TELEGRAM_MAX_CHARS,
  WORK_BUDGET_CHARS,
  HEADER_BUDGET_CHARS,
  clampEscaped,
  ACTIVITY_LINES,
  PANE_LINES,
  formatIdle,
  summarizeActivity,
} from "../../utils/status-render.ts";

const base = { stage: "working", elapsed: "2m 26s" };

describe("tailWithinBudget", () => {
  test("keeps the newest lines, not the oldest", () => {
    // The operator is watching what the session is doing *now*. The line they
    // have already read is the one to drop.
    expect(tailWithinBudget(["aaaa", "bbbb", "cccc"], 10)).toEqual(["bbbb", "cccc"]);
  });

  test("everything fits when there is room", () => {
    expect(tailWithinBudget(["a", "b"], 100)).toEqual(["a", "b"]);
  });

  test("one line that does not fit is truncated rather than dropped", () => {
    // An empty box says less than a clipped line — and the clip is marked, so a
    // trimmed line does not read as a whole one.
    expect(tailWithinBudget(["a".repeat(50)], 10)).toEqual([`${"a".repeat(9)}…`]);
  });

  test("nothing in, nothing out", () => {
    expect(tailWithinBudget([], 100)).toEqual([]);
  });
});

describe("the work half", () => {
  test("multi-line activity is an expandable quote", () => {
    // Expandable rather than a spoiler: the whole thing is in the message, the
    // message stays short until tapped, and the operator can see how much there
    // is rather than only that there is more.
    const out = renderStatus({ ...base, stage: "one\ntwo\nthree" });
    expect(out).toContain("<blockquote expandable>");
    expect(out).toContain("three");
  });

  test("a single line needs no quote at all", () => {
    const out = renderStatus({ ...base, stage: "Thinking" });
    expect(out).not.toContain("blockquote");
    expect(out).toContain("Thinking");
  });

  test("the pane is monospace", () => {
    // It is terminal output: tree characters, aligned columns, diffs. In a
    // proportional font a diff stops looking like a diff.
    const out = renderStatus({ ...base, pane: "├── src\n└── test" });
    expect(out).toContain("<pre>");
    expect(out).toContain("├── src");
  });

  test("the newest pane lines win", () => {
    const pane = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const out = renderStatus({ ...base, pane });
    expect(out).toContain("line 39");
    expect(out).not.toContain("line 0\n");
  });

  test("the pane keeps its last lines up to the limit", () => {
    const pane = Array.from({ length: 40 }, (_, i) => `L${i}`).join("\n");
    const out = renderStatus({ ...base, pane });
    const shown = out.slice(out.indexOf("<pre>"), out.indexOf("</pre>")).split("\n").length;
    expect(shown).toBeLessThanOrEqual(PANE_LINES);
  });

  test("markup in the output is escaped, not rendered", () => {
    // Terminal output is not ours, and this message is sent with parse_mode
    // HTML — an unescaped bracket fails the send silently.
    const out = renderStatus({ ...base, stage: "a\n<b>bold</b>", pane: "<script>x</script>" });
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});

describe("the statistics half", () => {
  test("says what it is working on", () => {
    // Four minutes means something different depending on the question.
    const out = renderStatus({ ...base, question: "почему упал деплой?" });
    expect(out).toContain("почему упал деплой?");
  });

  test("a long question is previewed, not pasted", () => {
    const out = renderStatus({ ...base, question: "x".repeat(400) });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(400);
  });

  test("a question spanning lines becomes one", () => {
    // The statistics half is glanceable; a paragraph in it is not.
    const out = renderStatus({ ...base, question: "first\n\nsecond" });
    expect(out).toContain("first second");
  });

  test("the operator's own words are escaped", () => {
    const out = renderStatus({ ...base, question: "почему <div> не рендерится" });
    expect(out).toContain("&lt;div&gt;");
    expect(out).not.toContain("<div>");
  });

  test("tools and files appear once there are any", () => {
    expect(renderStats({ ...base, toolCount: 8, fileCount: 2 })).toContain("🔧 8 tools · 2 files");
    expect(renderStats({ ...base, toolCount: 0 })).not.toContain("tools");
  });

  test("no question and no tools leaves no empty section", () => {
    expect(renderStats(base)).toBe("");
    expect(renderStatus(base)).not.toContain("\n\n");
  });
});

describe("the message always fits", () => {
  test("a flood of activity stays inside Telegram's limit", () => {
    // A rejected message is worse than a trimmed one: the operator sees nothing
    // at all rather than something.
    const stage = Array.from({ length: 400 }, (_, i) => `● step ${i} ${"x".repeat(120)}`).join("\n");
    const pane = Array.from({ length: 200 }, (_, i) => `pane ${i} ${"y".repeat(120)}`).join("\n");

    const out = renderStatus({ ...base, stage, pane, question: "z".repeat(300), toolCount: 99, fileCount: 9 });

    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("under pressure the newest work survives", () => {
    const stage = Array.from({ length: 200 }, (_, i) => `step ${i} ${"x".repeat(200)}`).join("\n");
    const out = renderStatus({ ...base, stage });
    expect(out).toContain("step 199");
  });

  test("a single enormous line is budgeted too", () => {
    // update_status takes whatever the caller passes and the tmux spinner text
    // is whatever the terminal drew. Neither is bounded, and Telegram rejects
    // an over-long message rather than trimming it.
    const out = renderStatus({ ...base, stage: "x".repeat(4097) });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("a single enormous line plus a pane and stats still fits", () => {
    const out = renderStatus({
      ...base,
      stage: "x".repeat(9000),
      pane: Array.from({ length: 50 }, () => "y".repeat(300)).join("\n"),
      question: "z".repeat(500),
      toolCount: 42,
      fileCount: 7,
    });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("an absurd token count cannot push the message over", () => {
    // The token count is scraped out of terminal output with a regex whose
    // `[\d.]+` will match a thousand digits as happily as three, and it lands
    // in the header — outside the work budget, where no amount of trimming
    // elsewhere can compensate for it.
    const out = renderStatus({ ...base, elapsed: `2m 26s · ↓ ${"9".repeat(4097)} tokens` });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(out).toContain("2m 26s");
  });

  test("every field oversized at once still fits", () => {
    const out = renderStatus({
      elapsed: "9".repeat(5000),
      stage: Array.from({ length: 300 }, (_, i) => `step ${i} ${"x".repeat(200)}`).join("\n"),
      pane: Array.from({ length: 300 }, () => "y".repeat(300)).join("\n"),
      tokens: "z".repeat(5000),
      question: "q".repeat(5000),
      spinner: "✶",
      phaseEmoji: "🧠",
      toolCount: 99,
      fileCount: 99,
    });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("the header budget is what it says", () => {
    const out = renderStatus({ ...base, elapsed: "e".repeat(HEADER_BUDGET_CHARS + 50) });
    expect(out).toContain(`${"e".repeat(HEADER_BUDGET_CHARS - 1)}…`);
    expect(out).not.toContain("e".repeat(HEADER_BUDGET_CHARS + 1));
  });

  test("an elapsed value at the budget is left alone", () => {
    // Both sides, so `>` cannot quietly become `>=` and clip every header.
    const exact = "e".repeat(HEADER_BUDGET_CHARS);
    expect(renderStatus({ ...base, elapsed: exact })).toContain(exact);
  });

  test("the header is escaped like everything else", () => {
    // It carries text scraped from the terminal, and the message is sent with
    // parse_mode HTML — an unescaped bracket fails the send outright.
    expect(renderStatus({ ...base, elapsed: "<b>2m</b>" })).toContain("&lt;b&gt;");
  });

  test("a flood of ampersands fits, and this is the test that nearly did not", () => {
    // Escaping happens after budgeting is the easy mistake, and it is invisible
    // to any test whose filler is `x`: `&` becomes `&amp;`, so 3,400 of them
    // reached Telegram as 17,010 characters and the message was rejected
    // outright. Terminal output is exactly where a run of ampersands comes from.
    const out = renderStatus({
      elapsed: "&".repeat(500),
      stage: "&".repeat(5000),
      pane: "&".repeat(5000),
      tokens: "&".repeat(500),
      question: "&".repeat(500),
      toolCount: 3,
      fileCount: 1,
    });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("the same, spread over many lines", () => {
    const out = renderStatus({
      ...base,
      stage: Array.from({ length: 200 }, (_, i) => `step ${i} ${"<&>".repeat(80)}`).join("\n"),
      pane: Array.from({ length: 200 }, () => "<&>".repeat(80)).join("\n"),
      question: "<&>".repeat(100),
    });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("truncation never leaves half an entity behind", () => {
    // `&am` is not `&amp;`. Telegram renders it as literal text at best, and at
    // worst reads it as an entity that swallows the tag after it.
    for (const max of [4, 5, 6, 7, 8, 9, 10, 11]) {
      const cut = clampEscaped("&amp;&amp;&amp;", max);
      // The marker is not part of the text: checking the returned string as-is
      // passes trivially, because it always ends with the ellipsis. That is
      // what the first version of this test did, and it survived removing the
      // entity guard entirely.
      const body = cut.endsWith("…") ? cut.slice(0, -1) : cut;
      expect([max, body, /&[#a-zA-Z0-9]*$/.test(body)]).toEqual([max, body, false]);
      expect([max, cut.length <= max]).toEqual([max, true]);
    }
  });

  test("a whole entity is kept whole", () => {
    expect(clampEscaped("&amp;", 5)).toBe("&amp;");
    expect(clampEscaped("abc", 10)).toBe("abc");
  });

  test("even the spinner cannot blow the message up", () => {
    // Ours today, and bounded anyway: the contract is that the output fits and
    // is well-formed, not that it does so as long as every caller behaves.
    const out = renderStatus({ ...base, spinner: "<b>".repeat(1400), phaseEmoji: "<i>".repeat(1400) });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<i>&");
  });

  test("the budget leaves room for everything else", () => {
    expect(WORK_BUDGET_CHARS).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(TELEGRAM_MAX_CHARS - WORK_BUDGET_CHARS).toBeGreaterThan(500);
  });

  test("the activity window is what it says", () => {
    const stage = Array.from({ length: 60 }, (_, i) => `s${i}`).join("\n");
    const out = renderStatus({ ...base, stage });
    const quoted = out.slice(out.indexOf("expandable>"), out.indexOf("</blockquote>"));
    expect(quoted.split("\n").length).toBeLessThanOrEqual(ACTIVITY_LINES);
    expect(quoted).toContain("s59");
  });
});

/**
 * The message a finished turn leaves behind.
 *
 * The closing edit replaced the whole status with its summary line, so the
 * work block was not collapsed when the turn ended — it was overwritten, and
 * an operator returning to the message had nothing to expand.
 */
describe("the finished turn keeps its work", () => {
  const SUMMARY = "✅ ⏱ 2m · 📝 3 files <code>+10/-4</code> · ↓ 18.1k tokens";

  test("the block is still there, collapsed", () => {
    const out = renderFinal(SUMMARY, "● Read: status.ts\n● $ git status");
    expect(out).toContain(SUMMARY);
    expect(out).toContain("<blockquote expandable>");
    expect(out).toContain("● Read: status.ts");
    expect(out).toContain("● $ git status");
  });

  test("the summary keeps its own markup", () => {
    // It is composed by the caller and carries <code> around the diff counts.
    // Escaping it here would show the tags instead of applying them.
    expect(renderFinal(SUMMARY, "● Read: x.ts")).toContain("<code>+10/-4</code>");
  });

  test("but the block is escaped", () => {
    const out = renderFinal(SUMMARY, "● Edit: src/<b>.ts");
    expect(out).toContain("&lt;b&gt;");
    expect(out).not.toContain("<b>");
  });

  test("no work means no empty quote", () => {
    expect(renderFinal(SUMMARY, "")).toBe(SUMMARY);
    expect(renderFinal(SUMMARY, "   \n  ")).toBe(SUMMARY);
    expect(renderFinal(SUMMARY, null)).toBe(SUMMARY);
    expect(renderFinal(SUMMARY, undefined)).toBe(SUMMARY);
  });

  test("and it still fits in a message", () => {
    const out = renderFinal(SUMMARY, Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(200)}`).join("\n"));
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(out).toContain(SUMMARY);
  });

  test("a single line too long for the budget is cut, not dropped", () => {
    // The other side of the bound: the block exists to say what happened, and
    // an empty quote says less than a truncated one.
    const out = renderFinal(SUMMARY, `● Edit: ${"p".repeat(5000)}.ts`);
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(out).toContain("● Edit: ppp");
  });

  test("a summary that already fills the budget drops the block rather than the notice", () => {
    const huge = `✅ ${"s".repeat(WORK_BUDGET_CHARS)}`;
    expect(renderFinal(huge, "● Read: x.ts")).toBe(huge);
  });

  test("the newest lines are the ones kept", () => {
    const out = renderFinal(SUMMARY, Array.from({ length: 200 }, (_, i) => `s${i}`).join("\n"));
    expect(out).toContain("s199");
    expect(out).not.toContain("s0\n");
  });
});

/**
 * The three lines that answer "is it still moving".
 *
 * The elapsed clock and the spinner both keep going for a turn that died three
 * minutes ago, which is why none of what follows can be derived from them.
 */
describe("the idle age", () => {
  test("seconds under a minute, minutes above", () => {
    expect(formatIdle(0)).toBe("0s");
    expect(formatIdle(3_400)).toBe("3s");
    expect(formatIdle(59_999)).toBe("59s");
    expect(formatIdle(60_000)).toBe("1m");
    expect(formatIdle(4 * 60_000 + 30_000)).toBe("4m");
  });

  test("rounded, so the edit-suppressing signature is not defeated", () => {
    // Two renders 400ms apart must produce the same text. Without rounding the
    // status would be edited on every tick for as long as a turn ran.
    expect(renderStatus({ ...base, idleMs: 3_100 })).toBe(renderStatus({ ...base, idleMs: 3_500 }));
  });

  test("it reaches the header", () => {
    expect(renderStatus({ ...base, idleMs: 3_000 })).toContain("⧗ 3s");
  });

  test("a status with no monitor claims nothing", () => {
    // Not "⧗ 0s": nothing has reported, so the age is unknown rather than zero,
    // and an unknown age must not read as a fresh one.
    const out = renderStatus({ ...base });
    expect(out).not.toContain("⧗");
  });

  test("a negative clock skew does not produce a negative age", () => {
    expect(formatIdle(-5_000)).toBe("0s");
  });

  test("it shares the header budget rather than adding to it", () => {
    // The budget exists because the elapsed field carries a token count scraped
    // with a regex. A new field appended outside the clamp would reopen the hole
    // the clamp was put there to close.
    const out = renderStatus({ ...base, elapsed: "e".repeat(HEADER_BUDGET_CHARS), idleMs: 3_000 });
    const field = out.slice(out.indexOf("<i>") + 3, out.indexOf("</i>"));
    expect(field.length).toBeLessThanOrEqual(HEADER_BUDGET_CHARS);
    // The age is what the overflow costs, not the clock that was there first.
    expect(field).not.toContain("⧗");
    expect(field.startsWith("e".repeat(HEADER_BUDGET_CHARS - 1))).toBe(true);
  });
});

describe("the subagents line", () => {
  test("says how many and what they are", () => {
    const out = renderStatus({ ...base, agents: ["explore", "review"] });
    expect(out).toContain("🧩 2 агента: explore · review");
  });

  test("one agent is not two", () => {
    expect(renderStatus({ ...base, agents: ["explore"] })).toContain("🧩 1 агент: explore");
  });

  test("none means no line at all", () => {
    expect(renderStatus({ ...base, agents: [] })).not.toContain("🧩");
    expect(renderStatus({ ...base })).not.toContain("🧩");
    // Whitespace is not an agent — a label that renders as nothing would leave
    // "2 агента: · " in the message.
    expect(renderStatus({ ...base, agents: ["  ", ""] })).not.toContain("🧩");
  });

  test("a label from a transcript is escaped", () => {
    expect(renderStatus({ ...base, agents: ["<b>"] })).toContain("&lt;b&gt;");
  });

  test("it sits above the work block, where trimming cannot reach it", () => {
    // `tailWithinBudget` drops from the front. A busy turn is exactly when the
    // operator wants to know two agents are running, so the line must not be
    // inside the thing that gets trimmed.
    const stage = Array.from({ length: 400 }, (_, i) => `● line ${i} ${"x".repeat(200)}`).join("\n");
    const out = renderStatus({ ...base, stage, agents: ["explore", "review"] });
    expect(out.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(out.indexOf("🧩")).toBeLessThan(out.indexOf("<blockquote"));
  });
});

describe("summarizeActivity", () => {
  test("the last tool call, without its bullet", () => {
    expect(summarizeActivity("● Read: a.ts\n● Edit: b.ts")).toBe("Edit: b.ts");
  });

  test("a subagent's label is not part of the answer", () => {
    // `markLines` writes the label after the bullet, so both markers have to go.
    expect(summarizeActivity("● [explore] Read: a.ts")).toBe("Read: a.ts");
    expect(summarizeActivity("[explore] Read: a.ts")).toBe("Read: a.ts");
  });

  test("a long agent name is still an agent name", () => {
    // `labelFor` caps a label it derives from a description, but returns
    // `agentType` at whatever length it is. A bounded pattern here read a long
    // custom agent's line as prose and dropped it. Raised in review.
    const long = "a-very-long-custom-subagent-type-name-that-exceeds-forty";
    expect(long.length).toBeGreaterThan(40);
    expect(summarizeActivity(`● [${long}] Read: a.ts`)).toBe("Read: a.ts");
  });

  test("prose is skipped in favour of the call above it", () => {
    // A paragraph of reasoning is not a summary of itself.
    expect(summarizeActivity("● Edit: b.ts\nI should check the tests next")).toBe("Edit: b.ts");
  });

  test("nothing that qualifies is null, not an empty line", () => {
    expect(summarizeActivity("just thinking out loud")).toBeNull();
    expect(summarizeActivity("")).toBeNull();
    expect(summarizeActivity("●   \n·  ")).toBeNull();
  });

  test("the spinner prefix is not mistaken for content", () => {
    expect(summarizeActivity("⏳ ● Read: a.ts")).toBe("Read: a.ts");
  });

  test("and the status carries it above the pane", () => {
    // Composed the way `formatStatusText` composes it: the renderer is handed
    // the summary rather than deriving one, so there is a single place that
    // decides what "happening now" means.
    const stage = "● Read: a.ts\n● Edit: b.ts";
    const out = renderStatus({ ...base, stage, pane: "├── src", summary: summarizeActivity(stage) });
    expect(out).toContain("▸ Edit: b.ts");
    expect(out.indexOf("▸ Edit: b.ts")).toBeLessThan(out.indexOf("<pre>"));
  });

  test("no summary means no marker", () => {
    expect(renderStatus({ ...base, stage: "thinking" })).not.toContain("▸");
  });
});

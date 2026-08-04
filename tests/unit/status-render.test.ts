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
  renderStats,
  tailWithinBudget,
  TELEGRAM_MAX_CHARS,
  WORK_BUDGET_CHARS,
  HEADER_BUDGET_CHARS,
  ACTIVITY_LINES,
  PANE_LINES,
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
    // An empty box says less than a clipped line.
    expect(tailWithinBudget(["a".repeat(50)], 10)).toEqual(["a".repeat(10)]);
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

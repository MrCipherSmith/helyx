import { describe, test, expect } from "bun:test";
import {
  isChrome,
  parseLine,
  parseStatus,
  CHROME_PATTERNS,
  SCRIPT_WRAPPER_PATTERNS,
  MAX_STATUS_LINES,
} from "../../utils/pane-parse.ts";

/**
 * The parser that turns Claude Code's terminal output into a status block.
 *
 * It existed twice — once for a captured tmux pane, once for a
 * `script`-captured file — and the two copies had drifted three ways while
 * nominally reading the same format. These tests cover the single definition
 * they now share, including each of those three drifts, so the resolution is
 * pinned rather than left to be re-derived.
 */

const ESC = "\x1b";

describe("parseLine — the ANSI drift", () => {
  test("an escape sequence at the start does not hide an anchored match", () => {
    // The pane-capture copy did not strip. Every pattern here is `^`-anchored,
    // so a line beginning with an escape silently failed to match — the same
    // defect flow 001 fixed in the supervisor and left standing here.
    expect(parseLine(`${ESC}[2K· Brewing…`)).toBe("⏳ Brewing…");
    expect(parseLine(`${ESC}[?25l● Bash(npm test)`)).toBe("● $ npm test");
  });

  test.each([
    ["· Brewing…", "⏳ Brewing…"],
    ["● Read(a.ts)", "● Read: a.ts"],
    ["⎿ Grep(x)", "  └ Grep: x"],
    ["+2 more tool uses", "  +2 more tool uses"],
    ["Running 3 agents…", "🔄 Running 3 agents…"],
  ])("clean input is unaffected: %s", (line, expected) => {
    // Stripping is free in that direction, across every branch and not just
    // the spinner the first version of this test covered.
    expect(parseLine(line)).toBe(expected);
  });

  test("a tab after the marker still parses", () => {
    // A tab is a C0 control, so stripping removed it and `●\tBash(ls)` reached
    // the patterns as `●Bash(ls)`, no longer matching `^●\s+`. The parser asks
    // for tabs to be kept.
    expect(parseLine("●\tBash(ls)")).toBe("● $ ls");
    expect(parseLine("·\tBrewing…")).toBe("⏳ Brewing…");
    expect(parseLine("⎿\tGrep(x)")).toBe("  └ Grep: x");
  });

  test("a tab inside the payload is preserved, not rewritten", () => {
    // The first attempt at the fix replaced every tab with a space, which was
    // a third behaviour: the pane copy kept the tab, the file copy deleted it,
    // and neither turned it into a space. Keeping it reproduces the copy that
    // parsed the line, payload included.
    expect(parseLine("● Some\tTool")).toBe("● Some\tTool");
  });

  test("other control characters are still removed", () => {
    // Only the tab is whitespace the patterns depend on; a stray CR or NUL is
    // noise and goes.
    expect(parseLine("● Bash(ls)\r")).toBe("● $ ls");
    expect(parseLine("●\x00 Bash(ls)")).toBe("● $ ls");
  });
});

describe("isChrome — the skip-list drift", () => {
  test("shared chrome is skipped", () => {
    for (const line of ["────────", "❯ ", "? for shortcuts", "esc to interrupt", "Enter to confirm", "  "]) {
      expect(isChrome(line)).toBe(true);
    }
  });

  test("the script wrapper is extra, not shared", () => {
    // Only the file reader wraps a session in these.
    expect(isChrome("Script started on 2026-08-03")).toBe(false);
    expect(isChrome("Script started on 2026-08-03", SCRIPT_WRAPPER_PATTERNS)).toBe(true);
    expect(isChrome("Script done on 2026-08-03", SCRIPT_WRAPPER_PATTERNS)).toBe(true);
  });

  test("an escape-anchored chrome pattern would be dead, which is why it is gone", () => {
    // The file-reading copy carried /^\x1b/. parseLine strips before isChrome
    // sees the line, so nothing could ever reach it starting with an escape.
    expect(CHROME_PATTERNS.some((p) => p.source.includes("x1b"))).toBe(false);
    expect(parseLine(`${ESC}[31m● Read(a.ts)`)).toBe("● Read: a.ts");
  });

  test("ordinary output is not chrome", () => {
    expect(isChrome("● Bash(ls)")).toBe(false);
  });
});

describe("parseLine — tool calls", () => {
  test.each([
    ["● Bash(npm run test)", "● $ npm run test"],
    ["● Read(/home/dev/helyx/utils/a.ts)", "● Read: a.ts"],
    ["● Edit(/home/dev/b.ts)", "● Edit: b.ts"],
    ["● Write(/home/dev/c.ts)", "● Write: c.ts"],
    ["● Agent(explore the repository)", "● Agent: explore the repository"],
    ["● Explore(find the callers)", "● Explore: find the callers"],
    ["● mcp__docker - container_list (MCP)", "● MCP: container_list"],
    ["● SomeOtherTool doing a thing", "● SomeOtherTool doing a thing"],
  ])("%s → %s", (line, expected) => {
    expect(parseLine(line)).toBe(expected);
  });

  test("the bot's own tools are not reported back to it", () => {
    expect(parseLine("● reply (MCP)")).toBeNull();
    expect(parseLine("● update_status (MCP)")).toBeNull();
  });

  test("a long bash command is truncated", () => {
    // Widened by half when the status message grew: the operator reads this to
    // see what the session is doing, and a command cut at sixty characters
    // usually cut off the part that said what it was doing to.
    const long = "x".repeat(200);
    expect(parseLine(`● Bash(${long})`)).toBe(`● $ ${"x".repeat(90)}`);
  });
});

describe("parseLine — sub-operations", () => {
  test("an error is marked", () => {
    expect(parseLine("⎿ Error: ENOENT no such file")).toBe("  └ ❌ Error: ENOENT no such file");
  });

  test("the Error branch gives the same answer wherever it sits in the order", () => {
    // The two copies checked it first and last. No other branch can match a
    // line starting "Error:" — it has no parentheses and does not begin with
    // one of the tool words — so both orders agreed. Pinned here rather than
    // left for whoever next moves it to re-derive.
    const line = "⎿ Error: something failed";
    expect(/^(\w+)\((.+)\)/.test("Error: something failed")).toBe(false);
    expect(/^(Read|Search|Grep|Glob|Write|Edit)\s/.test("Error: something failed")).toBe(false);
    expect(parseLine(line)).toContain("❌");
  });

  test("a tool sub-call carries its argument", () => {
    expect(parseLine("⎿ Grep(pattern here)")).toBe("  └ Grep: pattern here");
  });

  test("a summary line is kept as prose", () => {
    expect(parseLine("⎿ Read 2 files, listed 1 directory"))
      .toBe("  └ Read 2 files, listed 1 directory");
  });
});

describe("parseLine — the rest of the vocabulary", () => {
  test("more-tool-uses is indented, not decorated", () => {
    expect(parseLine("+3 more tool uses")).toBe("  +3 more tool uses");
  });

  test("a sub-agent announcement", () => {
    expect(parseLine("Running 4 agents…")).toBe("🔄 Running 4 agents…");
    expect(parseLine("Running agent…")).toBeNull(); // needs a count
  });

  test("an agent-tree row", () => {
    expect(parseLine("├─ Explore · 3 tool uses · 2.1k tokens"))
      .toBe("  ├─ Explore · 3 tool uses · 2.1k tokens");
  });

  test("an agent-tree sub-result", () => {
    expect(parseLine("├─ ⎿ Done: updated a.ts")).toBe("  │ ⎿ Done: updated a.ts");
  });

  test("a tip is not activity", () => {
    expect(parseLine("Tip: press ctrl-r")).toBeNull();
  });

  test("anything unrecognised carries nothing", () => {
    expect(parseLine("just some prose")).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("parseStatus", () => {
  test("collects activity bottom-up, oldest first in the result", () => {
    const pane = ["● Read(a.ts)", "● Bash(npm test)"].join("\n");
    expect(parseStatus(pane)).toBe("● Read: a.ts\n● $ npm test");
  });

  test("stops at the prompt line above the newest activity", () => {
    // The prompt is where the previous command ended; anything above it
    // belongs to a turn that is over.
    const pane = ["● Read(old.ts)", "❯ previous command", "● Bash(npm test)"].join("\n");
    expect(parseStatus(pane)).toBe("● $ npm test");
  });

  test("an ANSI-decorated prompt still ends the scan", () => {
    // The boundary check strips before testing for ❯, so a coloured prompt is
    // still a prompt. Without that, a decorated prompt would be invisible and
    // the scan would keep walking into the previous turn.
    const pane = ["● Read(old.ts)", `${ESC}[32m❯${ESC}[0m previous`, "● Bash(npm test)"].join("\n");
    expect(parseStatus(pane)).toBe("● $ npm test");
  });

  test("a prompt with nothing after it does not stop the scan early", () => {
    const pane = ["● Read(a.ts)", "❯ "].join("\n");
    expect(parseStatus(pane)).toBe("● Read: a.ts");
  });

  test("caps the block", () => {
    const pane = Array.from({ length: 30 }, (_, i) => `● Bash(cmd${i})`).join("\n");
    expect(parseStatus(pane)!.split("\n")).toHaveLength(MAX_STATUS_LINES);
  });

  test("keeps the newest lines when capping", () => {
    const pane = Array.from({ length: 30 }, (_, i) => `● Bash(cmd${i})`).join("\n");
    expect(parseStatus(pane)!.split("\n").at(-1)).toBe("● $ cmd29");
  });

  test("nothing to say is null, not an empty string", () => {
    expect(parseStatus("")).toBeNull();
    expect(parseStatus("? for shortcuts\nesc to interrupt")).toBeNull();
  });

  test("the script wrapper is skipped either way — the parameter states intent, not behaviour", () => {
    // Writing this test found that all three "extra" patterns the file reader
    // carried were already dead. `/^\x1b/` could not match because stripping
    // runs first; the two Script lines are prose, and prose falls through
    // every branch to null regardless. Passing them changes nothing today.
    //
    // The parameter is kept anyway, and this test says why rather than
    // implying the patterns do work: if the parser ever gains a prose
    // fallback, the wrapper must not become status text, and an explicit skip
    // is the cheapest way to hold that.
    const pane = ["Script started on 2026-08-03", "● Bash(npm test)"].join("\n");
    expect(parseStatus(pane)).toBe("● $ npm test");
    expect(parseStatus(pane, { extraChrome: SCRIPT_WRAPPER_PATTERNS })).toBe("● $ npm test");
  });

  test("the wrapper is skipped by isChrome when asked, not only by falling through", () => {
    // The distinction the test above turns on: with the parameter the line is
    // rejected as chrome, which is a different route to the same answer.
    expect(isChrome("Script started on 2026-08-03")).toBe(false);
    expect(isChrome("Script started on 2026-08-03", SCRIPT_WRAPPER_PATTERNS)).toBe(true);
  });
});

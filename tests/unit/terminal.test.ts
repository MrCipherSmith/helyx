import { describe, test, expect } from "bun:test";
import { stripAnsi, paneLines, isSpinnerLine, hasActiveSpinner, escapeHtml } from "../../utils/terminal.ts";

/**
 * Terminal-output parsing. Five call sites used to do this five different
 * ways; the three in the supervisor removed colour codes only, and fed the
 * result to a pattern anchored at the start of a line. These tests pin the
 * shared behaviour, with the cursor-sequence case that motivated the change.
 */

const ESC = "\x1b";

describe("stripAnsi", () => {
  test("removes SGR colour codes", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  test("removes cursor movement and erase sequences", () => {
    // The class the supervisor's SGR-only regex left behind.
    expect(stripAnsi(`${ESC}[2K${ESC}[1G· Thinking`)).toBe("· Thinking");
    expect(stripAnsi(`${ESC}[3A${ESC}[Kup`)).toBe("up");
  });

  test("removes OSC window-title sequences", () => {
    expect(stripAnsi(`${ESC}]0;helyx — bots\x07ready`)).toBe("ready");
  });

  test("removes stray control characters", () => {
    expect(stripAnsi("a\x00b\x1fc\rd")).toBe("abcd");
  });

  test("keeps newlines, since every caller splits on them", () => {
    expect(stripAnsi("a\nb\nc")).toBe("a\nb\nc");
  });

  test("strips tabs and carriage returns along with the other controls", () => {
    // Same range the two pre-existing implementations used; captured output is
    // read as text, and a CR mid-line only confuses whatever reads it.
    expect(stripAnsi("a\tb\rc")).toBe("abc");
  });

  test("leaves plain text untouched", () => {
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip");
  });

  test("handles an empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("strips sequences interleaved through a line", () => {
    expect(stripAnsi(`${ESC}[32m✓${ESC}[0m done ${ESC}[2Know`)).toBe("✓ done now");
  });

  test("a bare ESC that never became a sequence is dropped, not left in the text", () => {
    // ESC is itself a C0 control, so it goes with the rest — and crucially the
    // regexes do not get greedy and swallow the line after it.
    expect(stripAnsi(`${ESC}plain`)).toBe("plain");
  });

  test("multibyte glyphs are preserved", () => {
    expect(stripAnsi(`${ESC}[33m✶${ESC}[0m Crunching…`)).toBe("✶ Crunching…");
  });
});

describe("paneLines", () => {
  const raw = ["one", "", "two", "   ", "three", "four", ""].join("\n");

  test("returns the last N non-empty lines", () => {
    expect(paneLines(raw, 3)).toEqual(["   ", "three", "four"]);
  });

  test("drops empty lines but keeps whitespace-only ones", () => {
    // tmux pads with truly empty lines; a whitespace line is usually indentation.
    expect(paneLines("a\n\nb", 5)).toEqual(["a", "b"]);
  });

  test("asking for more lines than exist returns what there is", () => {
    expect(paneLines("a\nb", 10)).toEqual(["a", "b"]);
  });

  test("empty output yields no lines", () => {
    expect(paneLines("", 5)).toEqual([]);
    expect(paneLines("\n\n\n", 5)).toEqual([]);
  });

  test("strips before splitting, so escapes do not become content", () => {
    expect(paneLines(`${ESC}[2Kfirst\n${ESC}[31msecond${ESC}[0m`, 2)).toEqual(["first", "second"]);
  });
});

describe("isSpinnerLine", () => {
  test.each(["· Thinking", "✶ Crunching", "✻ Working"])("%s is a spinner", (line) => {
    expect(isSpinnerLine(line)).toBe(true);
  });

  test("leading whitespace is tolerated", () => {
    expect(isSpinnerLine("   · Thinking")).toBe(true);
  });

  test("the glyph must be followed by whitespace", () => {
    expect(isSpinnerLine("·Thinking")).toBe(false);
  });

  test("the glyph must lead the line", () => {
    expect(isSpinnerLine("done · Thinking")).toBe(false);
  });

  test("ordinary output is not a spinner", () => {
    expect(isSpinnerLine("✓ 284 tests passed")).toBe(false);
    expect(isSpinnerLine("")).toBe(false);
  });
});

describe("hasActiveSpinner", () => {
  test("finds a spinner in the tail", () => {
    expect(hasActiveSpinner("noise\nmore noise\n· Thinking")).toBe(true);
  });

  test("a spinner preceded by an erase sequence still counts", () => {
    // The regression this module exists for: with SGR-only stripping the line
    // began with ESC[2K, the ^ anchor missed, and a working session was
    // reported as hung.
    expect(hasActiveSpinner(`output\n${ESC}[2K${ESC}[1G· Thinking`)).toBe(true);
  });

  test("no spinner means not working", () => {
    expect(hasActiveSpinner("$ ls\nREADME.md\n$ ")).toBe(false);
  });

  test("a spinner older than the lookback does not count", () => {
    const raw = ["· Thinking", ...Array(12).fill("scrolled past")].join("\n");
    expect(hasActiveSpinner(raw, 10)).toBe(false);
  });

  test("a spinner just inside the lookback counts", () => {
    const raw = ["· Thinking", ...Array(9).fill("after")].join("\n");
    expect(hasActiveSpinner(raw, 10)).toBe(true);
  });

  test("empty output is not working", () => {
    expect(hasActiveSpinner("")).toBe(false);
  });
});

describe("stripAnsi — sequence forms the narrow regexes missed", () => {
  test("private-mode sequences go, not just their ESC", () => {
    // ESC[?25l hides the cursor and is exactly what a CLI emits before it
    // starts drawing a spinner. A [0-9;]* pattern does not match it, the ESC
    // is eaten as a control character, and `?25l` is left in front of the
    // glyph — which is the failure this whole module exists to prevent.
    expect(stripAnsi(`${ESC}[?25l· Thinking`)).toBe("· Thinking");
    expect(stripAnsi(`${ESC}[?25h`)).toBe("");
  });

  test("colon-form SGR goes", () => {
    expect(stripAnsi(`${ESC}[38:2:255:0:0mred${ESC}[0m`)).toBe("red");
  });

  test("sequences with intermediate bytes go", () => {
    expect(stripAnsi(`${ESC}[1 qtext`)).toBe("text");
  });

  test("punctuation-final sequences go", () => {
    expect(stripAnsi(`${ESC}[0!ptext`)).toBe("text");
  });

  test("ST-terminated OSC goes, payload and all", () => {
    expect(stripAnsi(`${ESC}]0;helyx${ESC}\\ready`)).toBe("ready");
  });

  test("an OSC-8 hyperlink does not leak its URL into the text", () => {
    const link = `${ESC}]8;;file:///home/dev/helyx/README.md${ESC}\\README.md${ESC}]8;;${ESC}\\`;
    expect(stripAnsi(link)).toBe("README.md");
  });

  test("a private-mode sequence before a spinner keeps it detectable", () => {
    expect(hasActiveSpinner(`output\n${ESC}[?25l${ESC}[2K· Thinking`)).toBe(true);
  });
});

describe("escapeHtml", () => {
  test("escapes the three characters Telegram's HTML mode cares about", () => {
    expect(escapeHtml("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });

  test("escapes the ampersand first, so entities are not double-encoded wrong", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("real terminal output survives intact", () => {
    // A redirect and a shell && in one line — ordinary output that would
    // otherwise make Telegram reject the entire alert.
    expect(escapeHtml("$ cmd 2>&1 && echo <done>")).toBe("$ cmd 2&gt;&amp;1 &amp;&amp; echo &lt;done&gt;");
  });

  test("text with nothing to escape is unchanged", () => {
    expect(escapeHtml("plain output")).toBe("plain output");
  });

  test("an empty string stays empty", () => {
    expect(escapeHtml("")).toBe("");
  });
});

/**
 * What a transcript entry becomes, and what downstream still reads out of it.
 *
 * Two halves. The first is that the four block types the terminal scrape could
 * never show — reasoning, prose, the call with its argument, the result — now
 * produce lines at all.
 *
 * The second is the constraint, and it is the one worth a test: four consumers
 * in `channel/status.ts` and `utils/status-format.ts` recognise these lines by
 * shape. Asserting the strings would pin the shape; feeding them back through
 * the real consumers pins the *agreement*, which is the thing that would break
 * silently.
 */

import { describe, test, expect } from "bun:test";
import {
  renderEntry,
  renderBlock,
  renderToolUse,
  resultText,
  toolArgument,
  outputTokens,
  formatTokens,
  renderTokenLine,
  SIDECHAIN_PREFIX,
  PROSE_CHARS,
} from "../../utils/transcript-events.ts";
import { detectPhase, scrapeTokenInfo } from "../../utils/status-format.ts";
import type { TranscriptEntry } from "../../utils/transcript-locate.ts";

/** An assistant entry carrying the given content blocks. */
function assistant(content: unknown[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { type: "assistant", message: { content }, ...extra };
}

function user(content: unknown[]): TranscriptEntry {
  return { type: "user", message: { content } };
}

describe("renderToolUse", () => {
  test("a file tool names the file, not the path", () => {
    expect(renderToolUse({ type: "tool_use", name: "Read", input: { file_path: "/a/b/status.ts" } }))
      .toBe("● Read: status.ts");
  });

  test("Bash shows the command", () => {
    expect(renderToolUse({ type: "tool_use", name: "Bash", input: { command: "bun test" } }))
      .toBe("● $ bun test");
  });

  test("an MCP tool is named by its last segment", () => {
    expect(renderToolUse({ type: "tool_use", name: "mcp__helyx-channel__reply", input: {} }))
      .toBe("● MCP: reply");
  });

  test("a subagent shows what it was sent to do", () => {
    expect(renderToolUse({ type: "tool_use", name: "Task", input: { description: "find the leak" } }))
      .toBe("● Agent: find the leak");
  });

  test("an unknown tool still says something", () => {
    expect(renderToolUse({ type: "tool_use", name: "SomeNewTool", input: { thing: "value" } }))
      .toBe("● SomeNewTool: value");
  });

  test("a tool with no usable argument is still named", () => {
    expect(renderToolUse({ type: "tool_use", name: "SomeNewTool", input: { count: 3 } }))
      .toBe("● SomeNewTool");
  });

  test("a block with no name produces nothing", () => {
    expect(renderToolUse({ type: "tool_use", input: { file_path: "x.ts" } })).toBeNull();
  });
});

describe("toolArgument", () => {
  test("prefers what says the most about the call", () => {
    // Both present: the path is what the operator is watching for.
    expect(toolArgument({ command: "ls", file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });

  test("no input at all is not an error", () => {
    expect(toolArgument(undefined)).toBeNull();
  });
});

describe("resultText", () => {
  test("a plain string result", () => {
    expect(resultText("Sent to chat -100")).toBe("Sent to chat -100");
  });

  test("a list of blocks — both shapes the format uses", () => {
    expect(resultText([{ type: "text", text: "Sent" }])).toBe("Sent");
    expect(resultText([{ type: "tool_reference", tool_name: "mcp__x__reply" }])).toBe("mcp__x__reply");
  });

  test("an empty or unrecognised result is nothing, not a blank line", () => {
    expect(resultText("")).toBeNull();
    expect(resultText([])).toBeNull();
    expect(resultText(null)).toBeNull();
    expect(resultText([{ type: "image" }])).toBeNull();
  });
});

describe("renderBlock", () => {
  test("reasoning and prose reach the operator", () => {
    expect(renderBlock({ type: "thinking", thinking: "weighing two options" }))
      .toBe("🧠 weighing two options");
    expect(renderBlock({ type: "text", text: "Fixed the crash." }))
      .toBe("💬 Fixed the crash.");
  });

  test("newlines are collapsed — a status line is one line", () => {
    const line = renderBlock({ type: "thinking", thinking: "first\n\nsecond" });
    expect(line).toBe("🧠 first second");
    expect(line).not.toContain("\n");
  });

  test("prose is cut to a bounded preview", () => {
    const line = renderBlock({ type: "text", text: "x".repeat(PROSE_CHARS * 3) })!;
    expect(line.length).toBeLessThan(PROSE_CHARS + 10);
    expect(line.endsWith("…")).toBe(true);
  });

  test("a failed result is marked as one", () => {
    expect(renderBlock({ type: "tool_result", content: "boom", is_error: true }))
      .toBe("  └ ❌ boom");
  });

  test("an unknown block type produces nothing", () => {
    expect(renderBlock({ type: "image" })).toBeNull();
    expect(renderBlock({})).toBeNull();
  });
});

describe("renderEntry", () => {
  test("every block of an entry, in order", () => {
    expect(renderEntry(assistant([
      { type: "thinking", thinking: "check the file" },
      { type: "tool_use", name: "Read", input: { file_path: "/a/b/status.ts" } },
    ]))).toEqual(["🧠 check the file", "● Read: status.ts"]);
  });

  test("a subagent's work is marked as not the main thread", () => {
    expect(renderEntry(assistant(
      [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
      { isSidechain: true },
    ))).toEqual([`${SIDECHAIN_PREFIX}● $ ls`]);
  });

  test("results come from user entries", () => {
    expect(renderEntry(user([{ type: "tool_result", content: "ok" }]))).toEqual(["  └ ok"]);
  });

  // The noise types the format actually carries, plus the ones it may carry
  // next: this parser reads someone else's format, so silence is the default.
  test.each([
    ["attachment", { type: "attachment" }],
    ["mode", { type: "mode" }],
    ["permission-mode", { type: "permission-mode" }],
    ["last-prompt", { type: "last-prompt" }],
    ["queue-operation", { type: "queue-operation" }],
    ["system", { type: "system" }],
    ["a type nobody has seen yet", { type: "something-new-in-a-later-release" }],
    ["no type at all", {}],
    ["null", null],
  ])("%s produces no lines and does not throw", (_label, entry) => {
    expect(() => renderEntry(entry as TranscriptEntry | null)).not.toThrow();
    expect(renderEntry(entry as TranscriptEntry | null)).toEqual([]);
  });

  test("content that is not a list is not iterated", () => {
    expect(renderEntry({ type: "assistant", message: { content: "plain string" } })).toEqual([]);
    expect(renderEntry({ type: "assistant", message: {} })).toEqual([]);
    expect(renderEntry({ type: "assistant" })).toEqual([]);
  });
});

describe("tokens", () => {
  test("read from usage, and only when they are a number", () => {
    expect(outputTokens({ type: "assistant", message: { usage: { output_tokens: 208 } } })).toBe(208);
    expect(outputTokens({ type: "assistant", message: { usage: { output_tokens: "208" } } })).toBeNull();
    expect(outputTokens({ type: "assistant", message: {} })).toBeNull();
    expect(outputTokens(null)).toBeNull();
  });

  test("formatted the way the CLI shows them", () => {
    expect(formatTokens(208)).toBe("208 tokens");
    expect(formatTokens(3_900)).toBe("3.9k tokens");
    expect(formatTokens(1_200_000)).toBe("1.2M tokens");
  });
});

/**
 * The agreement, not the strings.
 *
 * These four are the reason the vocabulary is not a free choice. Each assertion
 * is a consumer that lives in another module reading a line produced here.
 */
describe("the existing consumers still understand these lines", () => {
  test("scrapeTokenInfo reads the header back", () => {
    expect(scrapeTokenInfo(renderTokenLine(3_900))).toBe("3.9k tokens");
  });

  test("detectPhase classifies a file read as reading", () => {
    const block = renderEntry(assistant([
      { type: "tool_use", name: "Read", input: { file_path: "/a/b/status.ts" } },
    ])).join("\n");
    expect(detectPhase(block)).toBe("reading");
  });

  test("detectPhase classifies a command as running", () => {
    const block = renderEntry(assistant([
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    ])).join("\n");
    expect(detectPhase(block)).toBe("running");
  });

  test("the line counter's pattern still finds its numbers", () => {
    // Copied from channel/status.ts:accumulateStats. On the terminal path this
    // sentence came from Claude Code's rendering of the diff; here it is
    // computed from the edit itself, and the summary's +N/-M keeps working.
    const pattern = /Added (\d+) lines?,\s*removed (\d+) lines?/;
    const line = renderToolUse({
      type: "tool_use",
      name: "Edit",
      input: { file_path: "/a/b.ts", old_string: "one\ntwo", new_string: "one\ntwo\nthree" },
    })!;
    const match = line.match(pattern)!;
    expect(match[1]).toBe("3");
    expect(match[2]).toBe("2");
  });

  test("a written file counts as all added", () => {
    expect(renderToolUse({
      type: "tool_use",
      name: "Write",
      input: { file_path: "/a/b.ts", content: "a\nb\nc" },
    })).toBe("● Write: b.ts · Added 3 lines, removed 0 lines");
  });

  test("an edit with no strings carries no counts", () => {
    expect(renderToolUse({ type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts" } }))
      .toBe("● Edit: b.ts");
  });

  test("the counts do not break the file name the counter reads", () => {
    const pattern = /●\s+(?:Read|Write|Edit|Create):\s*([^\s\n]+\.[a-zA-Z]{1,8})/i;
    const line = renderToolUse({
      type: "tool_use",
      name: "Edit",
      input: { file_path: "/a/b/status.ts", old_string: "x", new_string: "y" },
    })!;
    expect(line.match(pattern)?.[1]).toBe("status.ts");
    // …and the one accumulateStats uses for the edited-files set.
    expect(line.match(/● (?:Edit|Write):\s*([^\s\n]+)/)?.[1]).toBe("status.ts");
  });

  test("the file counter's pattern matches an edit line", () => {
    // Copied from channel/status.ts:accumulateTurnActivity — if that pattern
    // changes, this test is where the disagreement surfaces.
    const pattern = /●\s+(?:Read|Write|Edit|Create):\s*([^\s\n]+\.[a-zA-Z]{1,8})/i;
    const line = renderEntry(assistant([
      { type: "tool_use", name: "Edit", input: { file_path: "/a/b/status.ts" } },
    ]))[0]!;
    expect(line.match(pattern)?.[1]).toBe("status.ts");
  });

  test("every tool line starts with the bullet the counters look for", () => {
    for (const name of ["Read", "Write", "Bash", "Task", "mcp__x__reply", "Whatever"]) {
      const line = renderToolUse({ type: "tool_use", name, input: { file_path: "a.ts" } })!;
      expect(line.startsWith("● ")).toBe(true);
    }
  });
});

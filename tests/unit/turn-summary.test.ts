/**
 * The message that says the turn is over.
 *
 * The operator's report was "непонятно где конец, на чём остановился": the
 * status message froze on the terminal's last line and nothing followed. A
 * session's final text never leaves the terminal, so a turn that ends without
 * an explicit `reply` delivers nothing at all — and from the outside, finished
 * and hung look the same.
 */

import { describe, test, expect } from "bun:test";
import {
  summaryFor,
  parseTranscript,
  lastTurn,
  repliedThisTurn,
  finalAssistantText,
  isOperatorMessage,
  FORWARDED_MARKER,
  SUMMARY_BUDGET_CHARS,
} from "../../utils/turn-summary.ts";
import { TELEGRAM_MAX_CHARS } from "../../utils/status-render.ts";

/** One JSONL line, the shape Claude Code writes. */
const line = (o: unknown) => JSON.stringify(o);

const operator = (text: string) => line({ type: "user", message: { content: text } });
const said = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const thought = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } });
const used = (name: string) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
const result = (id = "toolu_1") =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });

const transcript = (...lines: string[]) => lines.join("\n");

describe("reading the transcript", () => {
  test("a half-written last line is not a failure", () => {
    // The hook fires while the file is still being appended to, so the last
    // line is routinely incomplete. Throwing here would lose the whole summary.
    const entries = parseTranscript(`${operator("hi")}\n${said("hello")}\n{"type":"assis`);
    expect(entries.length).toBe(2);
  });

  test("a line that parses but is not an object is skipped", () => {
    // `42` and `"text"` are valid JSON. Read for fields they cannot have, they
    // are a crash rather than a skipped line.
    expect(parseTranscript(`42\n"text"\nnull\n${said("real")}`).length).toBe(1);
  });

  test("a tool result is not the operator speaking", () => {
    // This is the distinction the whole turn boundary rests on: tool results
    // arrive as `type: "user"` too. Counting one as the operator cuts the turn
    // at the last tool call, and the summary becomes whatever was said before
    // it rather than the conclusion.
    expect(isOperatorMessage(JSON.parse(operator("hi")))).toBe(true);
    expect(isOperatorMessage(JSON.parse(result()))).toBe(false);
    expect(isOperatorMessage(JSON.parse(said("hi")))).toBe(false);
  });

  test("the turn is everything since the operator last spoke", () => {
    const entries = parseTranscript(
      transcript(operator("first"), said("old answer"), operator("second"), used("Bash"), result(), said("new answer")),
    );
    const turn = lastTurn(entries);

    expect(finalAssistantText(turn)).toBe("new answer");
  });

  test("a transcript with no operator message is all one turn", () => {
    const turn = lastTurn(parseTranscript(transcript(said("only thing said"))));
    expect(finalAssistantText(turn)).toBe("only thing said");
  });
});

describe("what counts as having spoken", () => {
  test("either reply tool counts", () => {
    // The tool is namespaced per server, and only one of the two routes to the
    // project topic — but both are the session having spoken, and this decides
    // whether to say something *again*.
    for (const name of ["mcp__helyx__reply", "mcp__helyx-channel__reply"]) {
      expect([name, repliedThisTurn(parseTranscript(used(name)))]).toEqual([name, true]);
    }
  });

  test("a tool that merely contains the word does not", () => {
    // `reply_draft` or `list_replies` is not a reply. Matching loosely here
    // suppresses the summary on a turn that said nothing to the operator.
    for (const name of ["mcp__helyx__list_replies", "ReplyDraft", "mcp__x__reply_all"]) {
      expect([name, repliedThisTurn(parseTranscript(used(name)))]).toEqual([name, false]);
    }
  });

  test("a reply in an earlier turn does not count", () => {
    const entries = parseTranscript(
      transcript(operator("first"), used("mcp__helyx__reply"), operator("second"), said("unsent")),
    );
    expect(repliedThisTurn(lastTurn(entries))).toBe(false);
  });
});

describe("what gets forwarded", () => {
  test("the final text, marked as coming from the bot", () => {
    const out = summaryFor(transcript(operator("go"), used("Bash"), result(), said("Done — all green.")));

    expect(out).toContain("Done — all green.");
    expect(out).toContain(FORWARDED_MARKER);
  });

  test("nothing when the session already spoke", () => {
    // Being told the same thing twice is its own failure.
    const out = summaryFor(transcript(operator("go"), used("mcp__helyx-channel__reply"), result(), said("Done.")));
    expect(out).toBeNull();
  });

  test("thinking is not speech", () => {
    // It is the session's reasoning, never addressed to the operator, and
    // forwarding it publishes something they were never meant to read.
    const out = summaryFor(transcript(operator("go"), thought("maybe I should check the logs first")));
    expect(out).toBeNull();
  });

  test("a turn of pure tool calls says nothing", () => {
    expect(summaryFor(transcript(operator("go"), used("Bash"), result(), used("Read"), result()))).toBeNull();
  });

  test("an empty or unparseable transcript is quiet, not a crash", () => {
    expect(summaryFor("")).toBeNull();
    expect(summaryFor("not json at all\n{{{")).toBeNull();
  });

  test("the last thing said wins", () => {
    const out = summaryFor(transcript(operator("go"), said("first thought"), used("Bash"), result(), said("final word")));
    expect(out).toContain("final word");
    expect(out).not.toContain("first thought");
  });

  test("several text blocks in one message are joined", () => {
    const two = line({
      type: "assistant",
      message: { content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
    });
    const out = summaryFor(transcript(operator("go"), two));
    expect(out).toContain("part one");
    expect(out).toContain("part two");
  });
});

describe("the message always fits and is well-formed", () => {
  test("markup in the session's own words is escaped", () => {
    // Sent with parse_mode HTML, and this text is full of code — an unescaped
    // bracket fails the send outright, which loses the summary entirely.
    const out = summaryFor(transcript(operator("go"), said("use <div> and a && b")));
    expect(out).toContain("&lt;div&gt;");
    expect(out).not.toContain("<div>");
  });

  test("a long answer is trimmed to fit", () => {
    const out = summaryFor(transcript(operator("go"), said("x".repeat(9000))));
    expect(out!.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("and a long answer full of ampersands too", () => {
    // Escaping multiplies length by five, and a message over the limit is
    // rejected rather than trimmed — the summary would simply never arrive.
    const out = summaryFor(transcript(operator("go"), said("&".repeat(9000))));
    expect(out!.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });

  test("the budget leaves room for the marker and the tags", () => {
    expect(SUMMARY_BUDGET_CHARS).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(TELEGRAM_MAX_CHARS - SUMMARY_BUDGET_CHARS).toBeGreaterThan(400);
  });

  test("an ordinary answer is not trimmed", () => {
    // The other side of the bound: the summary exists to be read whole.
    const real = "Заход 019 закрыт: PR #55 смерджен, 1039 тестов, health 68.";
    expect(summaryFor(transcript(operator("go"), said(real)))).toContain(real);
  });
});

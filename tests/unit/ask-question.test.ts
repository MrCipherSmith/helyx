/**
 * Carrying Claude's own questions to Telegram.
 *
 * The bug these decisions exist for: `AskUserQuestion` draws its own selector
 * in the terminal and is not a permission request, so nothing carried it to
 * Telegram. A session sat blocked for twenty-one minutes on a question the
 * operator could not see, while the supervisor called it hung.
 */

import { describe, test, expect } from "bun:test";
import {
  parseHookInput,
  answerCallbackData,
  parseAnswerCallback,
  shortRequestId,
  questionMessage,
  formatAnswers,
  denyWithAnswers,
  allAnswered,
  MAX_CALLBACK_BYTES,
  type Question,
} from "../../utils/ask-question.ts";

function hookPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "abc-123",
    cwd: "/home/altsay/keryx",
    tool_use_id: "toolu_01",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [
        {
          question: "Под каким именем публиковаться?",
          header: "Имя в npm",
          multiSelect: false,
          options: [
            { label: "@mrciphersmith/keryx", description: "Scoped-пакет" },
            { label: "Другое имя", description: "Переименовать проект" },
          ],
        },
      ],
    },
    ...overrides,
  });
}

describe("parseHookInput", () => {
  test("reads the questions, the options and where they came from", () => {
    const input = parseHookInput(hookPayload())!;
    expect(input.sessionId).toBe("abc-123");
    expect(input.cwd).toBe("/home/altsay/keryx");
    expect(input.toolUseId).toBe("toolu_01");
    expect(input.questions).toHaveLength(1);
    expect(input.questions[0]!.header).toBe("Имя в npm");
    expect(input.questions[0]!.options.map((o) => o.label)).toEqual([
      "@mrciphersmith/keryx",
      "Другое имя",
    ]);
  });

  test("another tool is not ours", () => {
    // The hook is registered with a matcher, but a matcher is configuration and
    // this is the check that does not depend on it being right.
    expect(parseHookInput(hookPayload({ tool_name: "Bash" }))).toBeNull();
  });

  test("unparseable input is declined, not guessed at", () => {
    // Returning null means the hook prints nothing and the tool runs as usual.
    // A hook that failed to understand its input must not refuse the call.
    expect(parseHookInput("")).toBeNull();
    expect(parseHookInput("not json")).toBeNull();
    expect(parseHookInput("null")).toBeNull();
    expect(parseHookInput("[]")).toBeNull();
  });

  test("a question with no options is left to the terminal", () => {
    // Nothing to put on a button, and this path offers no other way to answer.
    const raw = JSON.stringify({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "free text?", options: [] }] },
    });
    expect(parseHookInput(raw)).toBeNull();
  });

  test("one unrepresentable question declines the whole call", () => {
    // The trap this avoids: carrying the two questions that fit and dropping
    // the third looks accommodating, but an answer to the two denies the whole
    // tool call — and the third is then never put to anyone at all.
    const raw = JSON.stringify({
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "answerable?", options: [{ label: "yes" }] },
          { question: "free text?", options: [] },
        ],
      },
    });
    expect(parseHookInput(raw)).toBeNull();
  });

  test("multiSelect declines the whole call", () => {
    // One tap is one answer. A multi-select needs a way to say "these two, and
    // now I am done", which this path does not have.
    const raw = JSON.stringify({
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "single?", options: [{ label: "a" }] },
          { question: "several?", multiSelect: true, options: [{ label: "b" }, { label: "c" }] },
        ],
      },
    });
    expect(parseHookInput(raw)).toBeNull();
  });

  test("a blank question, or an option without a label, declines the call", () => {
    for (const questions of [
      [{ question: "   ", options: [{ label: "a" }] }],
      [{ question: "real?", options: [{ label: "yes" }, { label: "" }] }],
      [{ question: "real?", options: [{ label: "yes" }, { description: "no label" }] }],
    ]) {
      expect(parseHookInput(JSON.stringify({ tool_name: "AskUserQuestion", tool_input: { questions } }))).toBeNull();
    }
  });

  test("an empty question list is nothing to ask", () => {
    expect(parseHookInput(JSON.stringify({ tool_name: "AskUserQuestion", tool_input: { questions: [] } }))).toBeNull();
  });

  test("several questions are all carried — the tool is one call", () => {
    const raw = JSON.stringify({
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "one?", options: [{ label: "a" }] },
          { question: "two?", options: [{ label: "b" }] },
        ],
      },
    });
    expect(parseHookInput(raw)!.questions).toHaveLength(2);
  });
});

describe("callback payloads", () => {
  test("round-trip", () => {
    const data = answerCallbackData("a1b2c3d4", 1, 2);
    expect(parseAnswerCallback(data)).toEqual({ requestId: "a1b2c3d4", questionIndex: 1, optionIndex: 2 });
  });

  test("someone else's callback is not ours", () => {
    expect(parseAnswerCallback("perm:allow:req-1")).toBeNull();
    expect(parseAnswerCallback("sup:ack:helyx:3")).toBeNull();
    expect(parseAnswerCallback("ask:only:two")).toBeNull();
    expect(parseAnswerCallback("ask:id:x:0")).toBeNull();
    expect(parseAnswerCallback("ask::0:0")).toBeNull();
    expect(parseAnswerCallback("ask:id:-1:0")).toBeNull();
  });

  test("the payload fits Telegram's limit with room for long ids", () => {
    // Over 64 bytes and Telegram drops the button silently — it renders and
    // does nothing, which is indistinguishable from the bug being fixed.
    const data = answerCallbackData(shortRequestId(), 9, 9);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
  });

  test("the id is eight characters, whatever the random source returns", () => {
    expect(shortRequestId(() => 0)).toHaveLength(8);
    expect(shortRequestId(() => 0.999999)).toHaveLength(8);
    expect(shortRequestId()).toHaveLength(8);
  });
});

describe("the Telegram message", () => {
  const question: Question = {
    question: "Под каким именем публиковаться?",
    header: "Имя в npm",
    options: [
      { label: "@mrciphersmith/keryx", description: "Scoped-пакет под твоим аккаунтом" },
      { label: "Не публиковать", description: "Остаётся curl-installer" },
    ],
  };

  test("carries the question, the numbered options and their descriptions", () => {
    const { text } = questionMessage("a1b2c3d4", 0, question);
    expect(text).toContain("Под каким именем публиковаться?");
    expect(text).toContain("Имя в npm");
    expect(text).toContain("1. @mrciphersmith/keryx");
    expect(text).toContain("Scoped-пакет под твоим аккаунтом");
    expect(text).toContain("2. Не публиковать");
  });

  test("one button per option, each carrying its own index", () => {
    const { buttons } = questionMessage("a1b2c3d4", 3, question);
    expect(buttons.flat().map((b) => b.callback_data)).toEqual([
      "ask:a1b2c3d4:3:0",
      "ask:a1b2c3d4:3:1",
    ]);
  });

  test("markup in the question is escaped", () => {
    // Claude's own text, going into a parse_mode HTML send. Unescaped, one "<"
    // makes the send fail — and the question is lost exactly as before.
    const { text } = questionMessage("id", 0, {
      question: "почему <div> не рендерится?",
      options: [{ label: "a & b" }],
    });
    expect(text).toContain("&lt;div&gt;");
    expect(text).not.toContain("<div>");
    expect(text).toContain("a &amp; b");
    // The bot's own markup still is markup.
    expect(text).toContain("<b>");
  });

  test("a long label is trimmed on the button but kept in the body", () => {
    const long = "x".repeat(80);
    const { text, buttons } = questionMessage("id", 0, { question: "q?", options: [{ label: long }] });
    expect(buttons[0]![0]!.text.length).toBeLessThanOrEqual(44);
    expect(text).toContain(long);
  });
});

describe("what Claude is told", () => {
  const questions: Question[] = [
    { question: "Имя пакета?", options: [{ label: "scoped" }, { label: "переименовать" }] },
    { question: "Версия?", options: [{ label: "0.2.0" }, { label: "0.20.0" }] },
  ];

  test("each answer is named with its question", () => {
    // Two questions in one call: an answer that did not name its question could
    // be attached to the wrong one.
    const reason = formatAnswers(questions, [1, 0]);
    expect(reason).toContain("Имя пакета? → переименовать");
    expect(reason).toContain("Версия? → 0.2.0");
  });

  test("an unanswered question says so rather than being dropped", () => {
    expect(formatAnswers(questions, [0, null])).toContain("Версия? → (no answer)");
  });

  test("the hook output denies the call and carries the answers", () => {
    // A PreToolUse hook cannot hand back a synthetic tool result — it can only
    // allow, deny or edit the input. Denying with the answer in the reason is
    // how the answer reaches the model at all.
    const decision = JSON.parse(denyWithAnswers(questions, [0, 1]));
    expect(decision.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("0.20.0");
  });
});

describe("allAnswered", () => {
  test("every question, not just the first", () => {
    // The tool is one call. Denying after one of three answers would tell
    // Claude the other two were declined.
    expect(allAnswered([0, 1], 2)).toBe(true);
    expect(allAnswered([0, null], 2)).toBe(false);
    expect(allAnswered([0], 2)).toBe(false);
    expect(allAnswered([], 0)).toBe(true);
  });

  test("option zero is an answer", () => {
    // The first option is index 0, and a falsy check here would wait forever
    // for anyone who picked it.
    expect(allAnswered([0], 1)).toBe(true);
  });
});

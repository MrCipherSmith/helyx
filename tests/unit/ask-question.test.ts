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
  answerToast,
  type PressOutcome,
  freeTextCallbackData,
  submitCallbackData,
  isAnswered,
  isMultiAnswer,
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

  test("multiSelect is accepted, and carries its flag", () => {
    // It used to decline the whole call, because one tap is one answer and a
    // multi-select needs a way to say "these two, and now I am done". It has
    // one now — toggles and a submit — so the question travels instead of
    // being asked in a terminal nobody is watching.
    const raw = JSON.stringify({
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "single?", options: [{ label: "a" }] },
          { question: "several?", multiSelect: true, options: [{ label: "b" }, { label: "c" }] },
        ],
      },
    });
    const parsed = parseHookInput(raw);

    expect(parsed).not.toBeNull();
    expect(parsed!.questions[0]!.multiSelect).toBe(false);
    expect(parsed!.questions[1]!.multiSelect).toBe(true);
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
    expect(parseAnswerCallback(data)).toEqual({ requestId: "a1b2c3d4", questionIndex: 1, optionIndex: 2, freeText: false, submit: false });
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

  test("one button per option, each carrying its own index, then a way to type", () => {
    // The free-text button rides on every question, whatever its options: a
    // question worth asking is often one where none of them is right.
    const { buttons } = questionMessage("a1b2c3d4", 3, question);
    expect(buttons.flat().map((b) => b.callback_data)).toEqual([
      "ask:a1b2c3d4:3:0",
      "ask:a1b2c3d4:3:1",
      "ask:a1b2c3d4:3:t",
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
    expect(allAnswered([0, null as number | null], 2)).toBe(false);
    expect(allAnswered([0], 2)).toBe(false);
    expect(allAnswered([], 0)).toBe(true);
  });

  test("option zero is an answer", () => {
    // The first option is index 0, and a falsy check here would wait forever
    // for anyone who picked it.
    expect(allAnswered([0], 1)).toBe(true);
  });
});

describe("what the operator sees on the button they pressed", () => {
  test("every outcome has words", () => {
    // A callback answer is the only acknowledgement a press ever gets. No
    // toast means the button looks dead and gets pressed again — which is how
    // one lost answer becomes three.
    const outcomes: PressOutcome[] = [
      { status: "recorded", label: "Да", complete: false },
      { status: "recorded", label: "Да", complete: true },
      { status: "not-ours" },
      { status: "unknown" },
      { status: "already-answered" },
      { status: "expired" },
      { status: "out-of-range" },
    ];

    for (const outcome of outcomes) {
      const toast = answerToast(outcome);
      expect([outcome.status, toast.length > 0]).toEqual([outcome.status, true]);
    }
  });

  test("the last answer says the set is on its way", () => {
    // The difference between "recorded, still waiting" and "recorded, the
    // session is moving" is the whole reason the operator watches this toast.
    expect(answerToast({ status: "recorded", label: "Кнопки", complete: true })).toContain("отправляю");
    expect(answerToast({ status: "recorded", label: "Кнопки", complete: false })).not.toContain("отправляю");
  });

  test("the chosen option is named back", () => {
    // Buttons are small and several look alike; the toast is what confirms
    // which one was actually hit.
    expect(answerToast({ status: "recorded", label: "Кнопки и маршрутизация", complete: false }))
      .toContain("Кнопки и маршрутизация");
  });

  test("a second press on an answered question says so", () => {
    expect(answerToast({ status: "already-answered" })).toBe("Уже отвечено");
  });

  test("a question that stopped waiting reads the same either way", () => {
    // Expired and unknown differ in the database and not to the operator:
    // both mean the press changed nothing and retyping is the way forward.
    expect(answerToast({ status: "expired" })).toBe(answerToast({ status: "unknown" }));
  });

  test("anything else admits it failed rather than claiming success", () => {
    expect(answerToast({ status: "out-of-range" })).toContain("Не удалось");
    expect(answerToast({ status: "not-ours" })).toContain("Не удалось");
  });
});

describe("answering in the operator's own words", () => {
  test("the free-text press is not an option press, and neither parses as the other", () => {
    // They share a shape, and telling them apart is what stops "let me type"
    // from being recorded as an answer nobody chose. `Number("t")` is NaN, so
    // the marker cannot be read as an index.
    const typed = parseAnswerCallback(freeTextCallbackData("a1b2c3d4", 2));
    expect(typed).toEqual({ requestId: "a1b2c3d4", questionIndex: 2, optionIndex: null, freeText: true, submit: false });

    const chosen = parseAnswerCallback(answerCallbackData("a1b2c3d4", 2, 0));
    expect(chosen!.freeText).toBe(false);
    expect(chosen!.optionIndex).toBe(0);
  });

  test("an option index of zero is still an option", () => {
    // The falsy trap: option 0 is the first choice, not "no choice".
    expect(parseAnswerCallback("ask:id:0:0")!.freeText).toBe(false);
    expect(parseAnswerCallback("ask:id:0:0")!.optionIndex).toBe(0);
  });

  test("a typed answer is marked as typed when Claude reads it back", () => {
    // Printed like a label, the operator's sentence would read as one of the
    // options offered — and a model reading it back would treat their words as
    // its own suggestion.
    const questions = [{ question: "Куда деплоить?", multiSelect: false, options: [{ label: "staging" }] }];
    const out = formatAnswers(questions, ["на прод, но сначала миграции"]);

    expect(out).toContain('(typed) "на прод, но сначала миграции"');
    expect(out).not.toContain("staging");
  });

  test("a chosen option still reads as a label", () => {
    const questions = [{ question: "Куда деплоить?", multiSelect: false, options: [{ label: "staging" }] }];
    expect(formatAnswers(questions, [0])).toContain("→ staging");
  });

  test("typed and chosen answers mix in one call", () => {
    const questions = [
      { question: "Куда?", multiSelect: false, options: [{ label: "staging" }] },
      { question: "Когда?", multiSelect: false, options: [{ label: "сейчас" }] },
    ];
    const out = formatAnswers(questions, [0, "после релиза"]);

    expect(out).toContain("→ staging");
    expect(out).toContain('(typed) "после релиза"');
  });

  test("typed words count as answered, blank ones do not", () => {
    // Pressing "Свой ответ" and sending a blank line must leave the question
    // waiting rather than closing the whole call with nothing in it.
    expect(allAnswered(["что-нибудь"], 1)).toBe(true);
    expect(allAnswered([""], 1)).toBe(false);
    expect(allAnswered(["   "], 1)).toBe(false);
    expect(allAnswered([0], 1)).toBe(true);
    expect(allAnswered([null], 1)).toBe(false);
  });

  test("the operator is told the next message is the answer", () => {
    // Instruction, not confirmation: nothing has been recorded yet.
    expect(answerToast({ status: "awaiting-text", label: "Куда деплоить?" })).toContain("следующим сообщением");
  });

  test("the free-text button is on a question of its own row", () => {
    // Its own row so it cannot be hit while aiming for the last option.
    const { buttons } = questionMessage("id", 0, {
      question: "q",
      multiSelect: false,
      options: [{ label: "a" }, { label: "b" }],
    });
    expect(buttons.at(-1)).toEqual([{ text: "✏️ Свой ответ", callback_data: "ask:id:0:t" }]);
  });
});

describe("typed words cannot forge an answer", () => {
  test("a newline in the answer does not become a second entry", () => {
    // The format is one answer per line and typed words go into it verbatim.
    // A message carrying a newline and "- Environment? → production" would
    // arrive at Claude as an answer to a question nobody asked, attributed to
    // the operator and indistinguishable from a chosen option.
    const questions = [{ question: "Куда?", multiSelect: false, options: [{ label: "staging" }] }];
    const out = formatAnswers(questions, ["ship both\n- Environment? → production"]);

    expect(out.split("\n")).toHaveLength(2);
    expect(out).not.toContain("\n- Environment? → production");
  });

  test("the whole answer still reaches Claude, escaped rather than cut", () => {
    // Quoted, not truncated: the operator said all of it and Claude needs all
    // of it. Only the newline stops being a line break.
    const questions = [{ question: "Куда?", multiSelect: false, options: [{ label: "staging" }] }];
    const out = formatAnswers(questions, ["первое\nвторое"]);

    expect(out).toContain("первое");
    expect(out).toContain("второе");
  });

  test("a quote in the answer does not break the quoting", () => {
    const questions = [{ question: "Что?", multiSelect: false, options: [{ label: "a" }] }];
    const out = formatAnswers(questions, ['он сказал "нет"']);

    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("нет");
  });
});

describe("a question where several answers are right", () => {
  const multi = { question: "Что включить?", multiSelect: true, options: [{ label: "тесты" }, { label: "линт" }, { label: "дубли" }] };
  const single = { question: "Куда?", multiSelect: false, options: [{ label: "staging" }, { label: "прод" }] };

  test("options are toggles, and a submit sits under them", () => {
    const { buttons } = questionMessage("id", 0, multi);
    const captions = buttons.flat().map((b) => b.text);

    expect(captions.filter((c) => c.startsWith("☐"))).toHaveLength(3);
    // Submit last: it is the press that closes the question, and it should sit
    // where the operator lands after working down the options.
    expect(captions.at(-1)).toContain("Готово");
    expect(captions.at(-2)).toContain("Свой ответ");
  });

  test("the toggles show what is currently chosen", () => {
    // The operator is building a set over several taps and the message text
    // cannot say "and now these two" — the buttons have to.
    const { buttons } = questionMessage("id", 0, multi, [0, 2]);
    const captions = buttons.flat().map((b) => b.text);

    expect(captions[0]).toContain("☑");
    expect(captions[1]).toContain("☐");
    expect(captions[2]).toContain("☑");
    expect(captions.find((c) => c.includes("Готово"))).toContain("(2)");
  });

  test("a single-select question gets no submit and keeps its numbers", () => {
    // One tap is still one answer; a submit there would ask for a second press
    // that means nothing.
    const captions = questionMessage("id", 0, single).buttons.flat().map((b) => b.text);

    expect(captions.some((c) => c.includes("Готово"))).toBe(false);
    expect(captions[0]).toContain("1.");
  });

  test("submit and option presses cannot be mistaken for one another", () => {
    const submit = parseAnswerCallback(submitCallbackData("id", 1));
    expect(submit).toEqual({ requestId: "id", questionIndex: 1, optionIndex: null, freeText: false, submit: true });

    const option = parseAnswerCallback(answerCallbackData("id", 1, 0));
    expect(option!.submit).toBe(false);

    const typed = parseAnswerCallback(freeTextCallbackData("id", 1));
    expect([typed!.submit, typed!.freeText]).toEqual([false, true]);
  });

  test("nothing is answered until it is submitted", () => {
    // The whole difference from single select. Without it the first tap is the
    // answer, which is why these questions used to be refused outright.
    expect(isAnswered({ picked: [0, 1], done: false })).toBe(false);
    expect(isAnswered({ picked: [0, 1], done: true })).toBe(true);
  });

  test("an empty submission is not an answer", () => {
    // "None of these" is a real thing to say, but it is the free-text button's
    // answer, not an empty list.
    expect(isAnswered({ picked: [], done: true })).toBe(false);
  });

  test("several options reach Claude as several answers", () => {
    const out = formatAnswers([multi], [{ picked: [0, 2], done: true }]);
    expect(out).toContain("тесты, дубли");
  });

  test("and one option is still one, not a list of one", () => {
    expect(formatAnswers([multi], [{ picked: [1], done: true }])).toContain("→ линт");
  });

  test("a submitted set of nothing reads as no answer", () => {
    expect(formatAnswers([multi], [{ picked: [], done: true }])).toContain("(no answer)");
  });

  test("an option index that no longer exists is dropped, not printed as undefined", () => {
    // The questions come from Claude and the indices from a button pressed
    // minutes later; a mismatch must not reach the model as the word
    // "undefined" sitting where an answer should be.
    expect(formatAnswers([multi], [{ picked: [0, 99], done: true }])).toContain("→ тесты");
    expect(formatAnswers([multi], [{ picked: [0, 99], done: true }])).not.toContain("undefined");
  });

  test("the running set is shown on every tap", () => {
    expect(answerToast({ status: "toggled", label: "тесты, линт", picked: 2 })).toContain("тесты, линт");
    expect(answerToast({ status: "toggled", label: "—", picked: 0 })).toContain("Ничего не выбрано");
  });

  test("a multi answer is recognised, and other shapes are not", () => {
    expect(isMultiAnswer({ picked: [1], done: false })).toBe(true);
    expect(isMultiAnswer({ picked: [1] })).toBe(false);
    expect(isMultiAnswer({ done: true })).toBe(false);
    expect(isMultiAnswer(null)).toBe(false);
    expect(isMultiAnswer(3)).toBe(false);
    expect(isMultiAnswer("текст")).toBe(false);
  });
});

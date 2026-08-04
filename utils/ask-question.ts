/**
 * Claude's own questions, on their way to Telegram and back.
 *
 * `AskUserQuestion` is a built-in tool that draws its own selector in the
 * terminal. It is not a permission request, so none of the machinery that
 * carries permission prompts to Telegram sees it — and on 2026-08-03 a session
 * sat blocked for twenty-one minutes on a question the operator could not see,
 * while the supervisor reported it as hung.
 *
 * The seam is a `PreToolUse` hook. It receives the question and every option as
 * structured data, before the selector is drawn — which is better than reading
 * the pane, where the options are wrapped, truncated and styled.
 *
 * ## Why the answer comes back as a refusal
 *
 * A `PreToolUse` hook cannot hand back a synthetic tool result; it can only
 * allow, deny, or edit the input. So an answer collected in Telegram is
 * returned by *denying* the call and putting the answer in the reason, which is
 * text Claude reads. The tool never runs, and the model continues knowing what
 * was chosen.
 *
 * The alternative was to let the selector render and type the answer into the
 * pane with `tmux send-keys`, the way terminal permission dialogs are answered.
 * That was the first design and it is worse: it depends on the selector's key
 * bindings, and a keystroke that arrives when no selector is up lands in the
 * prompt and becomes a message sent in the operator's name. That is not
 * hypothetical — it happened here, while probing the selector, and it is why
 * this path avoids the pane entirely.
 *
 * The hook's own timeout is 600 seconds, the same wait the permission flow
 * allows. Past it Claude Code proceeds as though no hook had run: the selector
 * appears and the terminal still works.
 */

/** One option offered for a question. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** One question as the tool was called with it. */
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** What the hook receives on stdin, reduced to what matters. */
export interface HookInput {
  sessionId: string;
  cwd: string;
  toolUseId: string;
  questions: Question[];
}

/** Callback payloads are capped at 64 bytes by Telegram. */
export const MAX_CALLBACK_BYTES = 64;

/** How long the hook waits for an answer before letting the terminal have it. */
export const ANSWER_TIMEOUT_MS = 570_000;

/**
 * Read the hook's stdin payload.
 *
 * Returns `null` for anything that is not an `AskUserQuestion` call with at
 * least one answerable question. A hook that cannot understand its input must
 * do nothing and let the tool run — refusing a call it failed to parse would
 * break the terminal for a case it never handled.
 */
export function parseHookInput(raw: string): HookInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const input = parsed as Record<string, unknown>;
  if (input.tool_name !== "AskUserQuestion") return null;

  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const rawQuestions = Array.isArray(toolInput?.questions) ? toolInput!.questions : [];

  // All or nothing.
  //
  // Skipping a question this path cannot represent — one with no options, or a
  // multi-select — and carrying the rest looks accommodating and is a trap: an
  // answer to the others denies the *whole* tool call, and the skipped question
  // is never put to anyone. The operator answers two of three and the third
  // silently disappears. Better to decline the call entirely and let the
  // terminal ask all of them, which is what happens today.
  if (rawQuestions.length === 0) return null;

  const questions: Question[] = [];
  for (const q of rawQuestions as Record<string, unknown>[]) {
    if (typeof q?.question !== "string" || !q.question.trim()) return null;

    const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
    const usable = options
      .filter((o) => typeof o?.label === "string" && o.label.trim())
      .map((o) => ({ label: String(o.label), description: typeof o.description === "string" ? o.description : undefined }));
    if (usable.length !== options.length || usable.length === 0) return null;

    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: usable,
    });
  }

  return {
    sessionId: String(input.session_id ?? ""),
    cwd: String(input.cwd ?? ""),
    toolUseId: String(input.tool_use_id ?? ""),
    questions,
  };
}

/**
 * The callback payload for choosing option `optionIndex` of question
 * `questionIndex`.
 *
 * The request id is generated short rather than a UUID because the whole
 * payload has 64 bytes and three fields to fit into them.
 */
export function answerCallbackData(requestId: string, questionIndex: number, optionIndex: number): string {
  return `ask:${requestId}:${questionIndex}:${optionIndex}`;
}

/** The marker that means "let me type it" rather than an option index. */
export const FREE_TEXT_MARKER = "t";
/** The marker that means "these are my answers, send them". */
export const SUBMIT_MARKER = "s";

/** The press that submits a multi-select question. */
export function submitCallbackData(requestId: string, questionIndex: number): string {
  return `ask:${requestId}:${questionIndex}:${SUBMIT_MARKER}`;
}

/** The press that asks for a free-text answer to this question. */
export function freeTextCallbackData(requestId: string, questionIndex: number): string {
  return `ask:${requestId}:${questionIndex}:${FREE_TEXT_MARKER}`;
}

/**
 * One answer slot: an option index, the operator's own words, or nothing yet.
 */
export type Answer = number | string | MultiAnswer | null | undefined;

/**
 * A multi-select answer while it is being made.
 *
 * `done` is the point. A half-toggled question must keep the call waiting —
 * without it the first tap would be the answer, which is exactly why
 * multi-select questions used to be refused rather than sent.
 */
export interface MultiAnswer {
  picked: number[];
  done: boolean;
}

/** Whether a slot holds a multi-select answer in progress. */
export function isMultiAnswer(value: unknown): value is MultiAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.picked) && typeof v.done === "boolean";
}

export interface AnswerCallback {
  requestId: string;
  questionIndex: number;
  /** The option chosen, or null when the operator asked to type instead. */
  optionIndex: number | null;
  freeText: boolean;
  submit: boolean;
}

/** Read a callback payload, or `null` if it is not one of ours. */
export function parseAnswerCallback(data: string): AnswerCallback | null {
  const parts = data.split(":");
  if (parts.length !== 4 || parts[0] !== "ask") return null;
  const questionIndex = Number(parts[2]);
  if (!parts[1] || !Number.isInteger(questionIndex) || questionIndex < 0) return null;

  // "Let me type it" and "option t" have to be distinguishable, and they are
  // because an option is always a number: `Number("t")` is NaN, so the marker
  // cannot be mistaken for an index and an index cannot be mistaken for it.
  if (parts[3] === FREE_TEXT_MARKER) {
    return { requestId: parts[1]!, questionIndex, optionIndex: null, freeText: true, submit: false };
  }
  if (parts[3] === SUBMIT_MARKER) {
    return { requestId: parts[1]!, questionIndex, optionIndex: null, freeText: false, submit: true };
  }

  const optionIndex = Number(parts[3]);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return null;
  return { requestId: parts[1]!, questionIndex, optionIndex, freeText: false, submit: false };
}

/**
 * An id short enough to leave room for the rest of the payload.
 *
 * Eight characters of base36 out of a caller-supplied random source. Uniqueness
 * only has to hold among the questions outstanding at one moment, which is
 * rarely more than one.
 */
export function shortRequestId(random: () => number = Math.random): string {
  let id = "";
  while (id.length < 8) id += Math.floor(random() * 36 ** 6).toString(36);
  return id.slice(0, 8);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The message for one question: the text, and a button per option.
 *
 * Descriptions go in the body rather than on the buttons — a Telegram button
 * caption is one short line, and the description is what makes the options
 * distinguishable. Everything the caller wrote is escaped: it is Claude's text
 * going into an HTML-parsed send, and an unescaped `<` makes the send fail
 * silently, which here would mean the question is lost exactly as before.
 */
export function questionMessage(
  requestId: string,
  questionIndex: number,
  question: Question,
  picked: readonly number[] = [],
): { text: string; buttons: { text: string; callback_data: string }[][] } {
  const lines: string[] = [];
  const header = question.header ? ` · ${escapeHtml(question.header)}` : "";
  lines.push(`❓ <b>Вопрос${header}</b>`);
  lines.push("");
  lines.push(escapeHtml(question.question));

  const buttons: { text: string; callback_data: string }[][] = [];
  question.options.forEach((option, optionIndex) => {
    lines.push("");
    lines.push(`<b>${optionIndex + 1}. ${escapeHtml(option.label)}</b>`);
    if (option.description) lines.push(`<i>${escapeHtml(option.description)}</i>`);

    const callback = answerCallbackData(requestId, questionIndex, optionIndex);
    // A payload too long for Telegram is dropped by the API and the button
    // silently does nothing, so an over-long one is left out rather than sent.
    if (Buffer.byteLength(callback, "utf8") <= MAX_CALLBACK_BYTES) {
      // A multi-select button shows its own state: the operator is building a
      // set over several taps and has to see what is in it, since the message
      // text cannot say "and now these two".
      const mark = question.multiSelect ? (picked.includes(optionIndex) ? "☑ " : "☐ ") : `${optionIndex + 1}. `;
      buttons.push([{ text: `${mark}${trimButton(option.label)}`, callback_data: callback }]);
    }
  });

  // On every question, whatever its options.
  //
  // A question worth asking is often one where none of the offered options is
  // right, and that is exactly the question that used to stay in the terminal:
  // the hook declined the whole call rather than send something it could not
  // represent, and the operator never saw it.
  const freeText = freeTextCallbackData(requestId, questionIndex);
  if (Buffer.byteLength(freeText, "utf8") <= MAX_CALLBACK_BYTES) {
    buttons.push([{ text: "✏️ Свой ответ", callback_data: freeText }]);
  }

  if (question.multiSelect) {
    const submit = submitCallbackData(requestId, questionIndex);
    if (Buffer.byteLength(submit, "utf8") <= MAX_CALLBACK_BYTES) {
      // Without it there is no moment at which the answer is final, and the
      // first tap would be the answer — which is why these questions used to
      // be refused rather than sent.
      buttons.push([{ text: picked.length > 0 ? `✅ Готово (${picked.length})` : "✅ Готово", callback_data: submit }]);
    }
  }

  return { text: lines.join("\n"), buttons };
}

/** Button captions wrap badly past about this much. */
function trimButton(label: string): string {
  return label.length <= 40 ? label : `${label.slice(0, 39)}…`;
}

/**
 * What Claude is told once the questions have been answered.
 *
 * Written as prose rather than JSON because it is read by a model, and it names
 * both the question and the chosen option so the answer cannot be attached to
 * the wrong one when there were several.
 */
export function formatAnswers(questions: Question[], choices: readonly Answer[]): string {
  const lines = ["The user answered from Telegram rather than the terminal:"];
  questions.forEach((question, i) => {
    const chosen = choices[i];
    // Typed answers are marked as typed. Printed like a label, a sentence the
    // operator wrote would read as one of the options offered — and a model
    // reading it back would treat their words as its own suggestion.
    if (typeof chosen === "string" && chosen.trim()) {
      // Quoted, so the text cannot forge an entry.
      //
      // The format is one answer per line, and typed words go into it
      // verbatim. A message containing a newline followed by "- Environment? →
      // production" would arrive at Claude as a second answer to a question
      // nobody asked — indistinguishable from a chosen option, and attributed
      // to the operator. `JSON.stringify` escapes the newline, so the whole
      // answer stays on the line that says it was typed.
      lines.push(`- ${question.question} → (typed) ${JSON.stringify(chosen.trim())}`);
      return;
    }
    if (isMultiAnswer(chosen)) {
      const labels = chosen.picked
        .map((i) => question.options[i]?.label)
        .filter((l): l is string => typeof l === "string");
      lines.push(
        labels.length > 0
          ? `- ${question.question} → ${labels.join(", ")}`
          : `- ${question.question} → (no answer)`,
      );
      return;
    }
    const option = typeof chosen === "number" ? question.options[chosen] : undefined;
    lines.push(
      option
        ? `- ${question.question} → ${option.label}`
        : `- ${question.question} → (no answer)`,
    );
  });
  return lines.join("\n");
}

/** The JSON a PreToolUse hook prints to stop the tool and speak for the user. */
export function denyWithAnswers(questions: Question[], choices: readonly Answer[]): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: formatAnswers(questions, choices),
    },
  });
}

/**
 * Whether every question has been answered.
 *
 * All of them, because the tool is one call: answering the first of three and
 * denying on that alone would tell Claude the other two were declined.
 */
export function allAnswered(choices: readonly Answer[], expected: number): boolean {
  return choices.length === expected && choices.every(isAnswered);
}

/**
 * Whether one slot holds an answer.
 *
 * A typed answer counts, and an empty one does not: pressing "Свой ответ" and
 * sending a blank line must leave the question still waiting rather than
 * closing the whole call with nothing in it.
 */
export function isAnswered(choice: Answer): boolean {
  if (typeof choice === "string") return choice.trim().length > 0;
  // Submitted, and not empty. Toggling three options and walking away is not
  // an answer, and neither is submitting none — "none of these" is a real
  // thing to say, but it is the free-text button's answer, not an empty list.
  if (isMultiAnswer(choice)) return choice.done && choice.picked.length > 0;
  return typeof choice === "number";
}

/**
 * The shape of what happened to a press, without the service that decided it.
 *
 * Mirrors `AnswerOutcome` in `services/ask-question.ts`. Duplicated
 * deliberately rather than imported: this file is the pure half and is loaded
 * by the hook, which has no database and must not pull the service in behind
 * it. The duplicate detector will name the pair, and this comment is the
 * answer — two shapes that must agree, kept apart on purpose.
 */
export type PressOutcome =
  | { status: "recorded"; label: string; complete: boolean }
  | { status: "not-ours" }
  | { status: "unknown" }
  | { status: "already-answered" }
  | { status: "expired" }
  | { status: "out-of-range" }
  | { status: "awaiting-text"; label: string }
  | { status: "toggled"; label: string; picked: number };

/**
 * What the operator sees on the button they just pressed.
 *
 * A Telegram callback answer is the only acknowledgement a press ever gets: no
 * toast means the button looks dead and gets pressed again, which is how one
 * lost answer becomes three. Every outcome therefore has words, including the
 * ones that mean nothing was recorded.
 */
export function answerToast(outcome: PressOutcome): string {
  switch (outcome.status) {
    case "recorded":
      // "отправляю" only on the last one: it tells the operator the set is
      // closed and the session is moving, which is the difference between
      // waiting and being finished.
      return outcome.complete ? `✅ ${outcome.label} — отправляю` : `✅ ${outcome.label}`;
    case "toggled":
      // The running set, on every tap. The operator is building an answer over
      // several presses and the toast is the only place that says what is in
      // it so far without opening the message.
      return outcome.picked > 0 ? `☑ ${outcome.label}` : "☐ Ничего не выбрано";
    case "awaiting-text":
      // Instruction rather than confirmation: nothing has been recorded yet,
      // and the operator has to know the next thing they send is the answer.
      return "✏️ Напишите ответ следующим сообщением";
    case "already-answered":
      return "Уже отвечено";
    case "expired":
      return "Вопрос больше не ждёт ответа";
    case "unknown":
      // The session it belonged to is gone, or the wait timed out and the
      // question went back to the terminal.
      return "Вопрос больше не ждёт ответа";
    default:
      return "Не удалось записать ответ";
  }
}

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
    // Carried through the type but not supported here: one tap is one answer,
    // and a multi-select needs a way to say "these two and then done".
    if (q.multiSelect === true) return null;

    const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
    const usable = options
      .filter((o) => typeof o?.label === "string" && o.label.trim())
      .map((o) => ({ label: String(o.label), description: typeof o.description === "string" ? o.description : undefined }));
    if (usable.length !== options.length || usable.length === 0) return null;

    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: false,
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

export interface AnswerCallback {
  requestId: string;
  questionIndex: number;
  optionIndex: number;
}

/** Read a callback payload, or `null` if it is not one of ours. */
export function parseAnswerCallback(data: string): AnswerCallback | null {
  const parts = data.split(":");
  if (parts.length !== 4 || parts[0] !== "ask") return null;
  const questionIndex = Number(parts[2]);
  const optionIndex = Number(parts[3]);
  if (!parts[1] || !Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) return null;
  if (questionIndex < 0 || optionIndex < 0) return null;
  return { requestId: parts[1]!, questionIndex, optionIndex };
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
      buttons.push([{ text: `${optionIndex + 1}. ${trimButton(option.label)}`, callback_data: callback }]);
    }
  });

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
export function formatAnswers(questions: Question[], choices: (number | null)[]): string {
  const lines = ["The user answered from Telegram rather than the terminal:"];
  questions.forEach((question, i) => {
    const chosen = choices[i];
    const option = chosen === null || chosen === undefined ? undefined : question.options[chosen];
    lines.push(
      option
        ? `- ${question.question} → ${option.label}`
        : `- ${question.question} → (no answer)`,
    );
  });
  return lines.join("\n");
}

/** The JSON a PreToolUse hook prints to stop the tool and speak for the user. */
export function denyWithAnswers(questions: Question[], choices: (number | null)[]): string {
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
export function allAnswered(choices: (number | null)[], expected: number): boolean {
  return choices.length === expected && choices.every((c) => c !== null && c !== undefined);
}

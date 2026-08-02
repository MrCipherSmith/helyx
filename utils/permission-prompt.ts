/**
 * What a Claude Code permission dialog looks like — in one place.
 *
 * Two consumers need this answer: `scripts/tmux-watchdog.ts`, which acts on a
 * prompt, and `utils/status-format.ts`, which shows 💬 for one. They had two
 * definitions, and the second was written from a reading of the first rather
 * than from the first itself. Over one review cycle that produced three
 * different wrong answers — `or` instead of `and`, any digit instead of
 * option 1, any distance instead of a six-line window — each time in code
 * whose comment said it matched the watchdog.
 *
 * A comment claiming two things agree is not a mechanism. This is.
 */

/** The question. */
export const PERM_SIGNAL_RE = /do you want to proceed\?/i;

/** The highlighted first option. Only `1` — the dialog is not awaiting input otherwise. */
export const PERM_CHOICE_RE = /❯\s*1[.)]\s*yes/i;

/** How far below the question the choice may appear. */
export const PERM_CHOICE_WINDOW = 6;

/**
 * Index of the newest question line, or -1.
 *
 * Scanned bottom-up: a pane holds the history of the session, and the prompt
 * that matters is the last one.
 */
export function findPromptSignal(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERM_SIGNAL_RE.test(lines[i]!)) return i;
  }
  return -1;
}

/**
 * Whether these lines hold a live permission dialog.
 *
 * Both signals are required: the question, and the highlighted option below
 * it within the window. Either alone is not a prompt — `echo "Do you want to
 * proceed?"` is a shell command, and an unhighlighted `1. Yes` is a dialog
 * that has already been answered.
 */
export function isPermissionPrompt(lines: readonly string[]): boolean {
  const idx = findPromptSignal(lines);
  if (idx === -1) return false;
  const window = lines.slice(idx, Math.min(lines.length, idx + PERM_CHOICE_WINDOW));
  return window.some((l) => PERM_CHOICE_RE.test(l));
}

/**
 * Reading raw terminal output.
 *
 * Five call sites used to strip ANSI escapes with five different regexes, and
 * the three in the supervisor removed only SGR colour codes. That matters
 * because the stripped text is not just displayed — `hasActiveSpinner` anchors
 * a pattern at the start of a line, and a leftover cursor-movement sequence
 * sitting in front of the spinner glyph makes a working session read as hung.
 *
 * The behaviour here is the widest of the five, which was already shared by
 * `tmux-watchdog.ts` and `output-monitor.ts`: CSI sequences, OSC sequences, and
 * C0 control characters. Nothing downstream has a reason to want an escape
 * preserved.
 */

/** CSI: ESC [ … final-byte. Covers colour, cursor movement, erase, and the rest. */
const CSI = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** OSC: ESC ] … BEL. tmux and shells use these for window titles. */
const OSC = /\x1b\][^\x07]*\x07/g;

/**
 * C0 control characters, newline excepted.
 *
 * Newlines survive because every caller splits on them afterwards. Everything
 * else goes, including tabs and a lone ESC that never became a sequence —
 * captured pane output is read as text or shown to a human, and neither wants
 * a carriage return or a vertical tab in it. This is the range the two
 * pre-existing implementations already used.
 */
const CONTROLS = /[\x00-\x09\x0b-\x1f]/g;

/** Remove ANSI escape sequences and stray control characters. */
export function stripAnsi(s: string): string {
  return s.replace(CSI, "").replace(OSC, "").replace(CONTROLS, "");
}

/**
 * The last `count` non-empty lines of captured pane output, stripped.
 *
 * This is what goes into an incident alert and into the `/pane` dump: the tail
 * is the part that says what the session was doing, and blank lines are the
 * padding tmux emits to fill the window rather than content.
 */
export function paneLines(raw: string, count: number): string[] {
  return stripAnsi(raw)
    .split("\n")
    .filter(Boolean)
    .slice(-count);
}

/**
 * A Claude Code progress-spinner line.
 *
 * The glyphs are the ones the CLI cycles through while it is working. The
 * anchor is what makes stripping matter: `· Thinking…` is a spinner,
 * `[2K· Thinking…` — the same line with its erase sequence still attached —
 * is not, and reading it as "not working" is how an active session gets
 * reported as hung.
 */
export function isSpinnerLine(line: string): boolean {
  return /^[·✶✻]\s/.test(line.trim());
}

/**
 * Whether the pane shows Claude actively working, judged over the last
 * `lookback` lines.
 *
 * Used to warn the operator before they restart a session that is merely
 * thinking. Defaults to 10 lines: far enough back to catch a spinner that has
 * scrolled up a little, close enough that a spinner from minutes ago does not
 * count as now.
 */
export function hasActiveSpinner(raw: string, lookback = 10): boolean {
  return stripAnsi(raw)
    .split("\n")
    .slice(-lookback)
    .some(isSpinnerLine);
}

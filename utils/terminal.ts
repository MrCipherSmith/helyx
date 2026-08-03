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

/**
 * CSI: ESC `[`, parameter bytes, intermediate bytes, final byte — the ECMA-48
 * ranges rather than the digits-and-letters approximation the five originals
 * used.
 *
 * The parameter range matters here specifically. `ESC[?25l` hides the cursor
 * and is what a CLI emits right before it starts drawing a spinner; `?` is a
 * parameter byte, so a `[0-9;]*` pattern does not match the sequence, the ESC
 * is removed as a control character, and `?25l` is left sitting in front of
 * the spinner glyph — defeating the anchored match this module exists to
 * protect. Colon-form SGR (`ESC[38:2:255:0:0m`) fails the same way.
 */
const CSI = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

/**
 * OSC: ESC `]` … terminator, where the terminator is BEL or ST (`ESC \`).
 *
 * Only BEL was recognised before. ST-terminated titles are just as common, and
 * OSC-8 hyperlinks — which modern CLIs use for clickable paths — are always
 * ST-terminated, so their URLs leaked into the text as visible content.
 */
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

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

/** The same range with the tab (0x09) left in — see `StripOptions.keepTabs`. */
const CONTROLS_KEEPING_TABS = /[\x00-\x08\x0b-\x1f]/g;

export interface StripOptions {
  /**
   * Keep tabs.
   *
   * A tab is a C0 control and normally goes with the rest. A parser whose
   * patterns match on `\s` needs it kept: `●\tBash(ls)` arriving as
   * `●Bash(ls)` stops matching `^●\s+`, and the line is lost. Off by default,
   * so every existing caller keeps the behaviour it had.
   */
  keepTabs?: boolean;
}

/**
 * Remove ANSI escape sequences and stray control characters.
 *
 * OSC first: an ST terminator is itself an ESC sequence, so stripping CSI or
 * controls ahead of it would break the payload apart and leave the title text
 * behind.
 *
 * Note for streamed input: this is not incremental. A sequence split across
 * two chunks is not recognised in either half, and the fragments survive as
 * text. Callers reading a stream should accumulate first and strip the buffer,
 * which is what `bot/commands/codex.ts` does.
 */
export function stripAnsi(s: string, options: StripOptions = {}): string {
  const controls = options.keepTabs ? CONTROLS_KEEPING_TABS : CONTROLS;
  return s.replace(OSC, "").replace(CSI, "").replace(controls, "");
}

/**
 * Escape text for Telegram's HTML parse mode.
 *
 * Terminal output routinely contains `<`, `>` and `&` — a redirect, a diff
 * marker, a shell `&&`. Interpolated raw into a `<pre>` block, Telegram
 * rejects the whole message, so the alert an operator was supposed to receive
 * simply never arrives. Only these three characters need escaping; Telegram's
 * HTML mode ignores the rest.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

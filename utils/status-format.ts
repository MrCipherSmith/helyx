/**
 * What the live status message shows while Claude works.
 *
 * These decide the emoji, the elapsed time, the token count and whether an
 * edit is worth sending at all. They lived in `channel/status.ts`, the
 * third-worst hotspot in the project, and none of them was tested — including
 * the one that tells the operator a session is blocked and needs them.
 */

/** Parse `"2.5k tokens"`, `"15,234 tokens"`, `"1.2M tokens"` → an integer. */
export function parseTokenCount(s: string): number | null {
  // NOTE: the character class admits several dots, so "1.2.3 tokens" reaches
  // parseFloat and silently becomes 1. Preserved as-is rather than fixed here
  // — changing it changes what the status line shows, which is a decision of
  // its own. Pinned by a test so the behaviour is at least written down.
  const m = s.match(/^([\d,.]+)([kmKM]?)\s*tokens?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  const suffix = m[2]!.toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

/** Elapsed time, seconds under a minute and `Nm Ss` above. An hour reads as `60m 0s`. */
export function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_STALE_MS = 60_000;

/**
 * The spinner glyph, or ⚠️ when the monitor has stopped feeding updates.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the stale
 * threshold can be tested at its boundary.
 */
export function getSpinnerIcon(spinnerFrame: number, lastUpdateAt: number, now: number): string {
  if (now - lastUpdateAt > SPINNER_STALE_MS) return "⚠️";
  return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
}

/** FNV-1a 32-bit. Fast, no dependencies, and enough to suppress duplicate edits. */
export function computeSignature(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export type ActivityPhase =
  | "thinking" | "reading" | "writing" | "running" | "searching" | "waiting";

/** Claude Code's permission dialog, by the same signals `scripts/tmux-watchdog.ts` uses. */
const PROMPT_SIGNAL_RE = /do you want to proceed\?/i;
const PROMPT_CHOICE_RE = /❯\s*\d[.)]\s*yes/i;

/**
 * Whether the stage text is an actual permission prompt.
 *
 * Keyed on the shape of the dialog rather than on the words `permission`,
 * `approve` or `waiting` appearing somewhere in it. The version this replaced
 * scanned the whole blob for those three words, so any tool call that
 * mentioned one — `grep -rn "waiting" src/`, reading `docs/permissions.md`,
 * running `npm run approve-release` — raised 💬, the signal that means a
 * session is blocked and needs a human. In this codebase those words are
 * everywhere.
 *
 * The definition is shared with the watchdog deliberately: two independent
 * ideas of what a prompt looks like is how one of them silently stops
 * matching.
 */
export function isPermissionPrompt(stage: string): boolean {
  return PROMPT_SIGNAL_RE.test(stage) || PROMPT_CHOICE_RE.test(stage);
}

/**
 * Classify what the session is doing, for the emoji at the head of the line.
 *
 * Tool-call lines from `tmux-monitor.ts` all start with `● `:
 *   `● $ command` · `● Read: file` · `● Write: file` · `● MCP: tool` ·
 *   `● AgentType: desc` · `● toolname…`
 * Anything else is prose — a custom message, `Thinking…`, or the permission
 * dialog, which also carries a bullet for the tool it is asking about.
 *
 * Returns null for empty input so no emoji is shown at all.
 */
export function detectPhase(stage: string): ActivityPhase | null {
  const s = stage.trim().toLowerCase();
  if (!s) return null;

  if (isPermissionPrompt(stage)) return "waiting";

  // Multi-line: the spinner line comes first, the most recent tool line last.
  const lastBulletLine = s.split("\n").filter((l) => l.startsWith("● ")).at(-1) ?? "";
  if (lastBulletLine) {
    if (lastBulletLine.startsWith("● $")) return "running"; // Bash
    if (lastBulletLine.includes("● read")) return "reading";
    if (lastBulletLine.includes("● write") || lastBulletLine.includes("● edit") || lastBulletLine.includes("● creat")) return "writing";
    if (lastBulletLine.includes("grep") || lastBulletLine.includes("search") || lastBulletLine.includes("find") || lastBulletLine.includes("● mcp")) return "searching";
    return "running"; // MCP, Agent, generic tool
  }

  // Prose. A status written by hand may say it is waiting on someone, and
  // there is no tool line here for the words to have leaked out of.
  if (s.includes("permission") || s.includes("approve") || s.includes("waiting")) return "waiting";
  if (s.includes("write") || s.includes("edit") || s.includes("creat")) return "writing";
  if (s.includes("read")) return "reading";
  if (s.includes("bash") || s.includes("execut") || s.includes("run")) return "running";
  if (s.includes("grep") || s.includes("search") || s.includes("find")) return "searching";
  return "thinking";
}

export const PHASE_LABEL: Record<ActivityPhase, string> = {
  thinking: "🧠",
  reading: "📖",
  writing: "✏️",
  running: "⚡",
  searching: "🔍",
  waiting: "💬",
};

/**
 * Prefix a status so that `detectPhase` reports `waiting`.
 *
 * Used by the permission handler, which knows a prompt is going out and
 * should not leave the classifier to infer it. The pane path cannot: by the
 * time `tmux-monitor` is done, the "Do you want to proceed?" line and the ❯
 * choice line have both been dropped as UI chrome, so the dialog reaches the
 * status line as nothing but the tool bullet it was asking about.
 */
export const WAITING_PREFIX = "⏳ Waiting for approval — ";

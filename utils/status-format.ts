/**
 * What the live status message shows while Claude works.
 *
 * These decide the emoji, the elapsed time, the token count and whether an
 * edit is worth sending at all. They lived in `channel/status.ts`, the
 * third-worst hotspot in the project, and none of them was tested — including
 * the one that tells the operator a session is blocked and needs them.
 */

import { isPermissionPrompt as isPromptLines } from "./permission-prompt.ts";

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

/**
 * Whether the stage text is an actual permission prompt.
 *
 * Delegates to `utils/permission-prompt.ts` rather than restating the rule.
 * The version this replaced scanned the whole blob for the words `permission`,
 * `approve` or `waiting`, so any tool call that mentioned one — `grep -rn
 * "waiting" src/`, reading `docs/permissions.md`, running `npm run
 * approve-release` — raised 💬, the signal that means a session is blocked and
 * needs a human. In this codebase those words are everywhere.
 *
 * The first three attempts to restate the watchdog's rule here each got it
 * wrong in a different way. Sharing the predicate removes the possibility.
 */
export function isPermissionPrompt(stage: string): boolean {
  return isPromptLines(stage.split("\n"));
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
 * The phase to show, given the classifier and whether a permission prompt is
 * pending.
 *
 * The latch outranks the classifier, and that is the whole point. A blocked
 * session's stage still reads like ordinary work — `channel/permissions.ts`
 * sets `Running: npm test` while the prompt is up, and the dialog's own text
 * never reaches here because `tmux-monitor` drops it. Without something that
 * knows, 💬 cannot be true; with it, the stage stays informative and only the
 * emoji is forced, so the operator sees 💬 *and* what is being asked about.
 *
 * An empty stage while blocked still shows the signal: nothing to describe is
 * not the same as nothing happening.
 */
export function resolvePhase(stage: string, awaitingPermission: boolean): ActivityPhase | null {
  if (awaitingPermission) return "waiting";
  return detectPhase(stage);
}

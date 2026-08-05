/**
 * The card that answers "what is happening", and looks nothing like a reply.
 *
 * It has to be told apart at a glance from the session speaking: the operator
 * asks this while waiting for an answer, and a card that read like one would be
 * mistaken for the thing it is reporting on.
 *
 * Facts first, always. The two lines from the local model go underneath and
 * behind a rule, and when the model is down they are simply absent — a card
 * without them is still the answer, which is why they are last.
 */

import { escapeHtml } from "./html.ts";
import type { SessionSnapshot, Waiting } from "./session-snapshot.ts";

/** How much of a work line survives into the card. */
export const LINE_CHARS = 120;

const WAITING_LABEL: Record<Waiting, string> = {
  permission: "⏸ ждёт разрешения",
  question: "❓ ждёт твоего ответа",
  working: "⚙️ работает",
  idle: "💤 тишина",
};

/** "12s", "4m", "1h 20m" — the same shape the status message uses. */
export function ago(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clip(line: string): string {
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line;
}

export interface NowCard {
  /** What the session is called. */
  project: string;
  snapshot: SessionSnapshot;
  /** Two lines from the local model, or null when it had nothing to say. */
  reading: string | null;
}

/**
 * Render the card.
 *
 * HTML rather than Markdown for the same reason the status message is: the work
 * lines come from a transcript and carry whatever the session typed, and only
 * escaping is trustworthy.
 */
export function renderNow(card: NowCard): string {
  const { snapshot: s } = card;
  const head = `📟 <b>${escapeHtml(card.project)}</b>`;

  if (!s.found) {
    return `${head}\n\n<i>Сессия не запущена — читать нечего.</i>`;
  }

  const lines = [`${head} · ${WAITING_LABEL[s.waiting]}`, ""];

  if (s.lastLine) {
    lines.push(`<code>${escapeHtml(clip(s.lastLine))}</code>`);
    lines.push(`<i>${ago(s.agoMs)} назад · ${s.tools} инструментов · ${s.files} файлов</i>`);
  } else {
    lines.push("<i>За последнее время ничего не записано.</i>");
  }

  if (s.agents.length > 0) {
    lines.push("", `<b>Сабагенты (${s.agents.length}):</b>`);
    for (const agent of s.agents) {
      const what = agent.lastLine ? escapeHtml(clip(agent.lastLine)) : "—";
      lines.push(`· <b>${escapeHtml(agent.label)}</b> ${what}`);
    }
  }

  // Under a rule and last: it is the only part that was not read off the disk,
  // and the card is complete without it.
  if (card.reading) {
    lines.push("", "───────", `<i>${escapeHtml(card.reading)}</i>`);
  }

  return lines.join("\n");
}

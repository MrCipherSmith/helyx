/**
 * What a session is doing, answered without asking it.
 *
 * The operator's report: "я не хочу постоянно писать какой статус и в некоторых
 * случаях не получать ответа". Asking goes through `message_queue`, and the
 * poller holds a message back while the chat is busy — so the answer arrives
 * when the turn ends, which is when it stops being interesting, and a stuck
 * session never answers at all.
 *
 * These pin the reading of the record and the rendering of the card. Neither
 * calls a model or touches a session, which is the whole point of the flow: the
 * answer was already on disk.
 */

import { describe, test, expect } from "bun:test";
import {
  snapshotFrom,
  waitingFrom,
  NO_SESSION,
  IDLE_AFTER_MS,
  type SessionSnapshot,
} from "../../utils/session-snapshot.ts";
import { renderNow, ago } from "../../utils/now-render.ts";

const NOW = Date.parse("2026-08-05T21:00:00.000Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const assistant = (text: string, secondsAgo = 5) =>
  JSON.stringify({ type: "assistant", timestamp: at(secondsAgo), message: { content: [{ type: "text", text }] } });

const toolCall = (name: string, input: Record<string, unknown>, secondsAgo = 5) =>
  JSON.stringify({ type: "assistant", timestamp: at(secondsAgo), message: { content: [{ type: "tool_use", name, input }] } });

describe("reading the record", () => {
  test("a project with nothing to read says so rather than failing", () => {
    // A session that was never started is a normal answer, not an error: the
    // operator asked and deserves a sentence.
    expect(snapshotFrom({ lines: [], now: NOW })).toEqual(NO_SESSION);
    expect(snapshotFrom({ lines: [], now: NOW }).found).toBe(false);
  });

  test("the last thing done, and how long ago", () => {
    const snapshot = snapshotFrom({
      lines: [assistant("older", 300), toolCall("Read", { file_path: "channel/status.ts" }, 12)],
      now: NOW,
    });

    expect(snapshot.found).toBe(true);
    expect(snapshot.lastLine).toContain("status.ts");
    expect(snapshot.agoMs).toBe(12_000);
  });

  test("the tools and the files of the window read", () => {
    const snapshot = snapshotFrom({
      lines: [
        toolCall("Read", { file_path: "a.ts" }),
        toolCall("Read", { file_path: "a.ts" }),
        toolCall("Edit", { file_path: "b.ts" }),
        toolCall("Bash", { command: "bun test" }),
      ],
      now: NOW,
    });

    // Files are distinct — the same file read twice is one file, and an
    // operator reading "4 files" would be reading a lie about the turn's reach.
    expect(snapshot.tools).toBe(4);
    expect(snapshot.files).toBe(2);
  });

  test("a line the parser cannot read costs that line and nothing else", () => {
    const snapshot = snapshotFrom({ lines: ["{not json", assistant("still here", 3)], now: NOW });

    expect(snapshot.lastLine).toContain("still here");
  });

  test("the subagents, and what each of them last did", () => {
    const snapshot = snapshotFrom({
      lines: [toolCall("Task", { description: "three explorers" })],
      agents: [
        { label: "Explore", lines: ["● [Explore] Read: one.ts", "● [Explore] Read: two.ts"] },
        { label: "code-reviewer", lines: ["● [code-reviewer] Grep: TODO"] },
      ],
      now: NOW,
    });

    expect(snapshot.agents).toHaveLength(2);
    expect(snapshot.agents[0]).toMatchObject({ label: "Explore" });
    expect(snapshot.agents[0]!.lastLine).toContain("two.ts");
    expect(snapshot.agents[1]!.lastLine).toContain("TODO");
  });
});

describe("what it is waiting on", () => {
  test("an open question outranks everything", () => {
    // It will sit for ever until someone answers, and that is the one thing the
    // operator can act on immediately.
    expect(waitingFrom({ lastTool: "Read", agoMs: 1_000, openQuestion: true })).toBe("question");
  });

  test("a question just asked reads as waiting even before the record says so", () => {
    expect(waitingFrom({ lastTool: "AskUserQuestion", agoMs: 1_000, openQuestion: false })).toBe("question");
  });

  test("silence past the window is idle, not working", () => {
    expect(waitingFrom({ lastTool: "Read", agoMs: IDLE_AFTER_MS, openQuestion: false })).toBe("idle");
    expect(waitingFrom({ lastTool: "Read", agoMs: IDLE_AFTER_MS - 1, openQuestion: false })).toBe("working");
  });

  test("a record with no time at all is not called idle", () => {
    // Absent is not the same as long ago, and "💤 тишина" for a session that is
    // working would be the snapshot lying in the direction that costs most.
    expect(waitingFrom({ lastTool: "Read", agoMs: null, openQuestion: false })).toBe("working");
  });
});

describe("the card", () => {
  const base: SessionSnapshot = {
    found: true,
    lastLine: "● Read: channel/status.ts",
    agoMs: 12_000,
    tools: 7,
    files: 3,
    waiting: "working",
    agents: [],
  };

  test("facts first, and the model's reading last", () => {
    const card = renderNow({ project: "helyx", snapshot: base, reading: "Дочитывает статус, осталось два файла." });

    const factsAt = card.indexOf("status.ts");
    const readingAt = card.indexOf("Дочитывает");
    expect(factsAt).toBeGreaterThan(-1);
    expect(readingAt).toBeGreaterThan(factsAt);
  });

  test("a model that said nothing costs its two lines and nothing else", () => {
    // The whole point of putting it last: the card is the answer without it.
    const card = renderNow({ project: "helyx", snapshot: base, reading: null });

    expect(card).toContain("status.ts");
    expect(card).toContain("7 инструментов");
    expect(card).not.toContain("───────");
  });

  test("what it is waiting on is in the first line, where the eye lands", () => {
    const card = renderNow({ project: "helyx", snapshot: { ...base, waiting: "question" }, reading: null });

    expect(card.split("\n")[0]).toContain("ждёт твоего ответа");
  });

  test("a session that was never started gets a sentence, not an empty card", () => {
    const card = renderNow({ project: "keryx", snapshot: NO_SESSION, reading: null });

    expect(card).toContain("keryx");
    expect(card).toContain("не запущена");
  });

  test("the subagents are listed under their names", () => {
    const card = renderNow({
      project: "helyx",
      snapshot: { ...base, agents: [{ label: "Explore", lastLine: "● [Explore] Read: one.ts", agoMs: null }] },
      reading: null,
    });

    expect(card).toContain("Сабагенты (1)");
    expect(card).toContain("Explore");
  });

  test("what the session typed cannot break the card", () => {
    // The work lines come from a transcript and carry whatever was typed into
    // it; the card is HTML, and only escaping is trustworthy.
    const card = renderNow({
      project: "helyx",
      snapshot: { ...base, lastLine: "● Read: <script>alert(1)</script> & co" },
      reading: null,
    });

    expect(card).toContain("&lt;script&gt;");
    expect(card).not.toContain("<script>");
  });

  test("a long line is clipped rather than allowed to fill the card", () => {
    const card = renderNow({ project: "helyx", snapshot: { ...base, lastLine: "● " + "x".repeat(400) }, reading: null });

    expect(card).toContain("…");
    expect(card.length).toBeLessThan(600);
  });
});

describe("how long ago it says", () => {
  test("seconds, minutes and hours, as the status message says them", () => {
    expect(ago(12_000)).toBe("12s");
    expect(ago(4 * 60_000)).toBe("4m");
    expect(ago(80 * 60_000)).toBe("1h 20m");
  });

  test("nothing to say is a dash, not a zero", () => {
    // "0s ago" would read as "just now", which is the opposite of "the record
    // does not say".
    expect(ago(null)).toBe("—");
  });
});

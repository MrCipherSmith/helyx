/**
 * The wiring, not the decision.
 *
 * `utils/turn-summary.ts` is pure and thoroughly tested, and none of that
 * proves a single message ever leaves the process. That distinction is not
 * academic here: twice in one day a fix in this area passed its own unit tests
 * while changing nothing the operator could see — once because the value was
 * written to a map nobody read, once because the fix was in a file the data
 * never passed through.
 *
 * So these run the real handler and the real watchdog writer and look at what
 * came out the other side.
 */

import { describe, test, expect } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { deliverTurnSummary, type TurnSummaryDeps } from "../../mcp/server.ts";
import { writePaneSnapshot } from "../../scripts/tmux-watchdog.ts";
import { FORWARDED_MARKER } from "../../utils/turn-summary.ts";

const PROJECT = "/home/altsay/bots/helyx";
const TOPIC = 1158;
const FORUM = "-1003908750902";

const line = (o: unknown) => JSON.stringify(o);
const operator = (text: string) => line({ type: "user", message: { content: text } });
const said = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const used = (name: string) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });

interface Sent {
  token: string;
  chatId: string;
  text: string;
  extra: Record<string, unknown>;
}

/** The handler with everything it touches replaced, and a record of what it sent. */
function harness(options: { transcript?: string; forum?: boolean; token?: string } = {}) {
  const sent: Sent[] = [];
  const db = new FakeSql();

  db.program("FROM sessions s", {
    rows: [{
      session_id: 7,
      chat_id: "-100777",
      forum_topic_id: options.forum === false ? null : TOPIC,
      forum_chat_id: options.forum === false ? null : FORUM,
    }],
  });

  const deps: TurnSummaryDeps = {
    sql: db.sql as unknown as TurnSummaryDeps["sql"],
    token: "token" in options ? options.token : "fake-token",
    read: () => {
      if (options.transcript === undefined) throw new Error("ENOENT");
      return options.transcript;
    },
    send: (async (token: string, chatId: string, text: string, extra: Record<string, unknown> = {}) => {
      sent.push({ token, chatId, text, extra });
      return { ok: true, messageId: 1 };
    }) as unknown as TurnSummaryDeps["send"],
  };

  return { deps, sent, db };
}

describe("delivering the summary", () => {
  test("a silent turn produces one message in the project's topic", async () => {
    // The whole feature in one assertion: the operator gets something to read,
    // and it lands where they are looking.
    const { deps, sent } = harness({
      transcript: [operator("go"), used("Bash"), said("Done — all green.")].join("\n"),
    });

    await deliverTurnSummary("/tmp/t.jsonl", PROJECT, deps);

    expect(sent.length).toBe(1);
    expect(sent[0]!.chatId).toBe(FORUM);
    expect(sent[0]!.extra.message_thread_id).toBe(TOPIC);
    expect(sent[0]!.text).toContain("Done — all green.");
  });

  test("sent as HTML, and marked as coming from the bot", async () => {
    // Both matter: the marker is escaped markup and would arrive as literal
    // text without the parse mode, and without the marker a forwarded summary
    // reads as something the session chose to say.
    const { deps, sent } = harness({ transcript: [operator("go"), said("done")].join("\n") });

    await deliverTurnSummary("/tmp/t.jsonl", PROJECT, deps);

    expect(sent[0]!.extra.parse_mode).toBe("HTML");
    expect(sent[0]!.text).toContain(FORWARDED_MARKER);
  });

  test("a turn that already replied sends nothing", async () => {
    // Being told the same thing twice is its own failure.
    const { deps, sent } = harness({
      transcript: [operator("go"), used("mcp__helyx-channel__reply"), said("done")].join("\n"),
    });

    await deliverTurnSummary("/tmp/t.jsonl", PROJECT, deps);

    expect(sent).toEqual([]);
  });

  test("without a topic it falls back to the chat rather than going quiet", async () => {
    const { deps, sent } = harness({
      transcript: [operator("go"), said("done")].join("\n"),
      forum: false,
    });

    await deliverTurnSummary("/tmp/t.jsonl", PROJECT, deps);

    expect(sent[0]!.chatId).toBe("-100777");
    expect(sent[0]!.extra.message_thread_id).toBeUndefined();
  });

  test("an unreadable transcript is silence, not a crash", async () => {
    // This runs at the end of work that already succeeded. It must never be
    // the reason a turn appears to fail.
    const { deps, sent } = harness({});
    await deliverTurnSummary("/tmp/missing.jsonl", PROJECT, deps);
    expect(sent).toEqual([]);
  });

  test("an unknown project sends nowhere", async () => {
    const { deps, sent, db } = harness({ transcript: [operator("go"), said("done")].join("\n") });
    db.program("FROM sessions s", { rows: [] });

    await deliverTurnSummary("/tmp/t.jsonl", "/somewhere/else", deps);

    expect(sent).toEqual([]);
  });

  test("a host path the container cannot open is retried where it is mounted", async () => {
    // The defect this covers: the hook reports the session's path from the
    // host, the bot reads it from inside a container, and the read threw on
    // every single turn. Silently — so the feature looked like a feature that
    // had nothing to say.
    const CONTAINER = "/host-claude-config/projects/p/t.jsonl";
    const { deps, sent } = harness({});
    const attempted: string[] = [];
    deps.read = (path: string) => {
      attempted.push(path);
      if (path !== CONTAINER) throw new Error("ENOENT");
      return [operator("go"), said("done")].join("\n");
    };
    deps.locate = (path: string) => (path === "/home/altsay/.claude/projects/p/t.jsonl" ? CONTAINER : null);

    await deliverTurnSummary("/home/altsay/.claude/projects/p/t.jsonl", PROJECT, deps);

    // The host path is still tried first: on a host process it succeeds and
    // nothing else runs.
    expect(attempted).toEqual(["/home/altsay/.claude/projects/p/t.jsonl", CONTAINER]);
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toContain("done");
  });

  test("a path that resolves nowhere is still silence", async () => {
    const { deps, sent } = harness({});
    deps.locate = () => null;

    await deliverTurnSummary("/home/altsay/.claude/projects/p/t.jsonl", PROJECT, deps);

    expect(sent).toEqual([]);
  });

  test("no token, no send, and no database query either", async () => {
    const { deps, sent, db } = harness({
      transcript: [operator("go"), said("done")].join("\n"),
      token: undefined,
    });

    await deliverTurnSummary("/tmp/t.jsonl", PROJECT, deps);

    expect(sent).toEqual([]);
    expect(db.count("FROM sessions s")).toBe(0);
  });
});

describe("what the watchdog stores as the pane", () => {
  test("the menu does not reach the database", async () => {
    // The end of the path the operator actually sees: the watchdog writes this
    // row, the status message reads it. A fix anywhere else in the chain is a
    // fix in a file the data never passes through — which is exactly how the
    // first attempt at this went.
    const db = new FakeSql();
    const pane = [
      "● Running tests",
      "  ⎿ 1073 passed",
      "  1. Досылать автоматически",
      "❯ 2. Только пометка",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ];

    await writePaneSnapshot(db.sql as never, 7, pane);

    const stored = String(db.matching("UPDATE sessions SET pane_snapshot")[0]?.values[0] ?? "");
    expect(stored).toContain("Running tests");
    expect(stored).toContain("1073 passed");
    expect(stored).not.toContain("Enter to select");
    expect(stored).not.toContain("Только пометка");
  });

  test("a pane of nothing but a menu writes no row at all", async () => {
    // Rather than blanking the snapshot the operator was reading.
    const db = new FakeSql();

    await writePaneSnapshot(db.sql as never, 7, ["  1. yes", "  2. no", "Enter to select"]);

    expect(db.count("UPDATE sessions SET pane_snapshot")).toBe(0);
  });
});

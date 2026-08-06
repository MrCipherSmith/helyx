/**
 * Where the rule is stated, and that it is stated at all.
 *
 * The rule — the operator reads what goes through `reply` and nothing else —
 * used to live in whichever project CLAUDE.md happened to mention it. `arena`
 * hung on that: its CLAUDE.md is about models, the session answered in its
 * terminal, and the topic got a status message with no answer under it. The
 * two vantage projects carry 44 KB of rules between them and never mention the
 * channel either; they work by the model guessing right.
 *
 * So the rule is now on three paths into the context, and these are about
 * whether it is really on them — the constants file could say anything, and if
 * nothing reads it the sessions are exactly where they were.
 */

import { describe, test, expect } from "bun:test";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "../../channel/tools.ts";
import { composeDelivery } from "../../channel/poller.ts";
import { CHANNEL_INSTRUCTIONS, REPLY_RULE_NOTE, REPLY_TOOL_DESCRIPTION } from "../../channel/reply-rule.ts";
import type { StatusManager } from "../../channel/status.ts";

/** The tool list as a client would receive it. */
async function toolList() {
  const handlers = new Map<unknown, (req: unknown) => Promise<{ tools: { name: string; description: string }[] }>>();
  const mcp = {
    setRequestHandler: (schema: unknown, fn: (req: unknown) => Promise<never>) => void handlers.set(schema, fn),
  };

  registerTools(
    { mcp, sql: (() => {}) as never, sessionId: () => 1 } as never,
    {} as StatusManager,
    () => {},
  );

  const list = handlers.get(ListToolsRequestSchema);
  if (!list) throw new Error("registerTools never registered a tool list");
  return (await list({})).tools;
}

describe("the rule as the client sees it", () => {
  test("the reply tool says it is the only way out", async () => {
    // It used to say "Send a message to a Telegram chat" — true, and no help
    // at all to a session deciding whether printing the answer is enough.
    const reply = (await toolList()).find((t) => t.name === "reply");

    expect(reply?.description).toBe(REPLY_TOOL_DESCRIPTION);
    expect(reply?.description).toMatch(/ONLY channel they read/);
    expect(reply?.description).toMatch(/terminal/i);
  });

  test("the server's instructions say it before the session has done anything", () => {
    // This is the copy that arrives in the system prompt, which is the only
    // one a project with no CLAUDE.md of its own ever gets.
    expect(CHANNEL_INSTRUCTIONS).toMatch(/`reply` tool is the only thing that reaches them/);
    expect(CHANNEL_INSTRUCTIONS).toMatch(/without calling `reply`/);
  });

  test("and every delivered message repeats it, in front of the operator's words", () => {
    // The one copy a long turn cannot leave behind.
    const delivered = composeDelivery({
      contextPrefix: "",
      isVoice: false,
      hint: "",
      replyBlock: "",
      content: "напиши тестовые скрипты",
    });

    expect(delivered.startsWith(REPLY_RULE_NOTE)).toBe(true);
    expect(delivered.endsWith("напиши тестовые скрипты")).toBe(true);
  });
});

describe("what else the delivered message carries", () => {
  test("the prior-session context stays first", () => {
    // It is the ground the rest stands on, and a rule note above it would read
    // as part of the recalled conversation.
    const delivered = composeDelivery({
      contextPrefix: "[Session context]\n\n",
      isVoice: false,
      hint: "",
      replyBlock: "",
      content: "go",
    });

    expect(delivered.indexOf("[Session context]")).toBe(0);
    expect(delivered.indexOf(REPLY_RULE_NOTE)).toBeGreaterThan(0);
  });

  test("a voice message still asks for a voice answer", () => {
    // The note the rule now sits in front of, which must not have displaced it.
    const delivered = composeDelivery({
      contextPrefix: "",
      isVoice: true,
      hint: "",
      replyBlock: "",
      content: "ты тут?",
    });

    expect(delivered).toContain("ALWAYS send a voice reply");
    expect(delivered).toContain(REPLY_RULE_NOTE);
  });

  test("hint and quoted message keep their places between the notes and the words", () => {
    const delivered = composeDelivery({
      contextPrefix: "",
      isVoice: false,
      hint: "[hint]\n",
      replyBlock: "[quote]\n",
      content: "проверь",
    });

    expect(delivered.indexOf("[hint]")).toBeLessThan(delivered.indexOf("[quote]"));
    expect(delivered.indexOf("[quote]")).toBeLessThan(delivered.indexOf("проверь"));
  });
});

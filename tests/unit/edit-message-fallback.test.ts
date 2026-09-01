/**
 * `edit_message`'s plain-text fallback, checked rather than assumed.
 *
 * The tool tries rich, then HTML, then — only for a Telegram "can't parse
 * entities" refusal — plain text. The plain-text call's own result used to be
 * discarded: the handler fell through to `return text("Message ... updated")`
 * unconditionally once it decided to try plain text at all, regardless of
 * whether that attempt actually landed. A message deleted out from under the
 * edit, or too old to edit, or simply gone, was reported to Claude as
 * successfully updated with no way to tell otherwise.
 *
 * F-011 (channel/tools.ts:659).
 */

import { describe, test, expect, mock, afterEach } from "bun:test";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { ToolContext } from "../../channel/tools.ts";
import type { StatusManager } from "../../channel/status.ts";

const TELEGRAM_MODULE = "../../channel/telegram.ts";
const PRISTINE: Record<string, unknown> = { ...(await import(TELEGRAM_MODULE)) };

type EditResult = { ok: boolean; errorBody?: string };

/** Program the three edit attempts `edit_message` can make, in order. */
function installEditChain(results: { rich?: EditResult; html?: EditResult; plain?: EditResult }) {
  const rich = results.rich ?? { ok: true };
  const html = results.html ?? { ok: true };
  const plain = results.plain ?? { ok: true };
  const calls: string[] = [];

  mock.module(TELEGRAM_MODULE, () => ({
    ...PRISTINE,
    editRichTelegramMessage: async () => {
      calls.push("rich");
      return rich;
    },
    // Both the HTML attempt and the final plain-text fallback go through
    // `editTelegramMessage` — the plain call is distinguished by having no
    // `extra` (no `parse_mode: "HTML"`).
    editTelegramMessage: async (_token: string, _chatId: string, _messageId: number, _text: string, extra?: Record<string, unknown>) => {
      if (extra?.parse_mode === "HTML") {
        calls.push("html");
        return html;
      }
      calls.push("plain");
      return plain;
    },
  }));

  return { calls };
}

function restore() {
  mock.module(TELEGRAM_MODULE, () => ({ ...PRISTINE }));
}

afterEach(restore);

/** Registers the real tool handlers and returns the `edit_message` caller. */
async function editMessageTool() {
  const { registerTools } = await import("../../channel/tools.ts");
  const handlers = new Map<unknown, (req: unknown) => Promise<{ content: { type: string; text: string }[] }>>();
  const mcp = {
    setRequestHandler: (schema: unknown, fn: (req: unknown) => Promise<never>) => void handlers.set(schema, fn),
  };
  const db = new FakeSql();
  const ctx: ToolContext = {
    sql: db.sql as unknown as ToolContext["sql"],
    mcp: mcp as never,
    sessionId: () => 1,
    sessionName: () => "helyx",
    projectPath: "/home/altsay/bots/helyx",
    token: () => "fake-token",
    ollamaUrl: "http://127.0.0.1:1",
    embeddingModel: "unused",
  };

  registerTools(ctx, {} as StatusManager, () => {});
  void handlers.get(ListToolsRequestSchema); // sanity: registerTools wired the list handler too

  const call = handlers.get(CallToolRequestSchema);
  if (!call) throw new Error("registerTools never registered CallToolRequestSchema");

  return (args: Record<string, unknown>) =>
    call({ params: { name: "edit_message", arguments: args } });
}

const ARGS = { chat_id: "-100123", message_id: 42, text: "*updated*" };

describe("edit_message's fallback chain", () => {
  test("rich succeeds: reports success without trying HTML or plain", async () => {
    const { calls } = installEditChain({ rich: { ok: true } });
    const editMessage = await editMessageTool();

    const result = await editMessage(ARGS);

    expect(calls).toEqual(["rich"]);
    expect(result.content[0]!.text).toContain("updated");
  });

  test("rich fails, HTML succeeds: reports success", async () => {
    const { calls } = installEditChain({
      rich: { ok: false, errorBody: "Bad Request: rich_message not supported" },
      html: { ok: true },
    });
    const editMessage = await editMessageTool();

    const result = await editMessage(ARGS);

    expect(calls).toEqual(["rich", "html"]);
    expect(result.content[0]!.text).toContain("updated");
  });

  test("rich and HTML both fail on entities, plain text lands: reports success", async () => {
    const { calls } = installEditChain({
      rich: { ok: false, errorBody: "Bad Request: rich_message not supported" },
      html: { ok: false, errorBody: "Bad Request: can't parse entities" },
      plain: { ok: true },
    });
    const editMessage = await editMessageTool();

    const result = await editMessage(ARGS);

    expect(calls).toEqual(["rich", "html", "plain"]);
    expect(result.content[0]!.text).toContain("updated");
  });

  test("the plain-text fallback also fails: reports the failure, not success", async () => {
    // This is the bug: the old code tried the plain-text edit, never looked at
    // what it returned, and always fell through to "updated".
    const { calls } = installEditChain({
      rich: { ok: false, errorBody: "Bad Request: rich_message not supported" },
      html: { ok: false, errorBody: "Bad Request: can't parse entities" },
      plain: { ok: false, errorBody: "Bad Request: message to edit not found" },
    });
    const editMessage = await editMessageTool();

    const result = await editMessage(ARGS);

    expect(calls).toEqual(["rich", "html", "plain"]);
    expect(result.content[0]!.text).not.toContain("updated");
    expect(result.content[0]!.text).toContain("message to edit not found");
  });

  test("HTML fails for a reason other than entities: reports the HTML failure, no plain attempt", async () => {
    const { calls } = installEditChain({
      rich: { ok: false, errorBody: "Bad Request: rich_message not supported" },
      html: { ok: false, errorBody: "Bad Request: message to edit not found" },
    });
    const editMessage = await editMessageTool();

    const result = await editMessage(ARGS);

    expect(calls).toEqual(["rich", "html"]);
    expect(result.content[0]!.text).not.toContain("updated");
  });
});

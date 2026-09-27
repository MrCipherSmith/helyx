/**
 * `send_document`'s local-path allowlist — F-002b's boundary, on the new tool.
 *
 * `sendTelegramDocument` reads any absolute path `Bun.file()` can open and
 * uploads the bytes. The tool that exposes it reads `path` from a session that
 * attacker-controlled content can steer, so the containment check in
 * `channel/tools.ts` is the only thing between "send the report" and "send
 * ~/.ssh/id_ed25519". A leaked photo is embarrassing; a leaked document is a
 * file with a name and a size, sitting in the recipient's chat, saveable.
 *
 * These tests drive the real `send_document` handler and assert the upload
 * never happens for a path outside the allowed roots, and still happens for a
 * path inside them.
 */

import { describe, test, expect, mock, afterEach } from "bun:test";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FakeSql } from "../fixtures/fake-sql.ts";
import type { ToolContext } from "../../channel/tools.ts";
import type { StatusManager } from "../../channel/status.ts";

const TELEGRAM_MODULE = "../../channel/telegram.ts";
const PRISTINE: Record<string, unknown> = { ...(await import(TELEGRAM_MODULE)) };

const PROJECT_PATH = "/home/altsay/bots/helyx";
const CHAT_ID = "-100999";

function installDocumentSpy() {
  const calls: { chatId: string; path: string }[] = [];
  mock.module(TELEGRAM_MODULE, () => ({
    ...PRISTINE,
    sendTelegramDocument: async (_token: string, chatId: string, path: string) => {
      calls.push({ chatId, path });
      return { ok: true, messageId: 1 };
    },
  }));
  return { calls };
}

function restore() {
  mock.module(TELEGRAM_MODULE, () => ({ ...PRISTINE }));
}

afterEach(restore);

/** Registers the real tool handlers and returns the `send_document` caller. */
async function sendDocumentTool() {
  const { registerTools } = await import("../../channel/tools.ts");
  const handlers = new Map<unknown, (req: unknown) => Promise<{ content: { type: string; text: string }[] }>>();
  const mcp = {
    setRequestHandler: (schema: unknown, fn: (req: unknown) => Promise<never>) => void handlers.set(schema, fn),
  };
  const db = new FakeSql();
  // A chat this bot already tracks — the authorized-chat check (F-004) is not
  // what these tests are about, so it is satisfied up front.
  db.program("FROM chat_sessions WHERE chat_id", { rows: [{ active_session_id: 1 }] });

  const ctx: ToolContext = {
    sql: db.sql as unknown as ToolContext["sql"],
    mcp: mcp as never,
    sessionId: () => 1,
    sessionName: () => "helyx",
    projectPath: PROJECT_PATH,
    token: () => "fake-token",
    ollamaUrl: "http://127.0.0.1:1",
    embeddingModel: "unused",
  };

  registerTools(ctx, {} as StatusManager, () => {});
  const call = handlers.get(CallToolRequestSchema);
  if (!call) throw new Error("registerTools never registered CallToolRequestSchema");

  return (args: Record<string, unknown>) =>
    call({ params: { name: "send_document", arguments: args } });
}

describe("send_document's local-path allowlist", () => {
  test("a path outside the project and outside HOST_PROJECTS_DIR/HOME is refused — Telegram is never called", async () => {
    const { calls } = installDocumentSpy();
    const sendDocument = await sendDocumentTool();

    const result = await sendDocument({ chat_id: CHAT_ID, path: "/etc/passwd" });

    expect(calls).toEqual([]);
    expect(result.content[0]!.text).not.toContain("Document sent");
    expect(result.content[0]!.text.toLowerCase()).toContain("path must be absolute and within");
  });

  test("a traversal that lexically re-enters the project is still refused", async () => {
    const { calls } = installDocumentSpy();
    const sendDocument = await sendDocumentTool();

    // `containsPath` resolves before comparing, so a `..`-laden path that
    // lands outside the project is caught the same as a bare absolute path.
    const result = await sendDocument({ chat_id: CHAT_ID, path: `${PROJECT_PATH}/../../../etc/passwd` });

    expect(calls).toEqual([]);
    expect(result.content[0]!.text.toLowerCase()).toContain("path must be absolute and within");
  });

  test("a relative path is refused — documents have no remote-URL form to fall back on", async () => {
    const { calls } = installDocumentSpy();
    const sendDocument = await sendDocumentTool();

    // Unlike send_photo there is no URL branch, so a relative path cannot be
    // reinterpreted as one; it is simply not a path this tool accepts.
    const result = await sendDocument({ chat_id: CHAT_ID, path: "report.pdf" });

    expect(calls).toEqual([]);
    expect(result.content[0]!.text.toLowerCase()).toContain("path must be absolute and within");
  });

  test("a path inside the current project is allowed through to Telegram", async () => {
    const { calls } = installDocumentSpy();
    const sendDocument = await sendDocumentTool();

    const documentPath = `${PROJECT_PATH}/reports/next-sprint-plan.pdf`;
    const result = await sendDocument({ chat_id: CHAT_ID, path: documentPath });

    expect(calls).toEqual([{ chatId: CHAT_ID, path: documentPath }]);
    expect(result.content[0]!.text).toContain("Document sent");
  });
});

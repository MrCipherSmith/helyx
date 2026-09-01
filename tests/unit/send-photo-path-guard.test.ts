/**
 * F-002b — `send_photo`'s local-path allowlist.
 *
 * `sendTelegramPhoto` (channel/telegram.ts) reads any absolute path
 * `Bun.file()` can open and uploads the bytes to Telegram. Before this fix,
 * `channel/tools.ts`'s `send_photo` case passed the caller-supplied `url`
 * straight through with no containment check — a session steered by
 * attacker-controlled content (a malicious repo, a fetched page) could be
 * made to read host-mounted credentials, another project's transcript, or
 * any other file the bot process can see, and exfiltrate it as a photo.
 *
 * These tests drive the real `send_photo` handler and assert the Telegram
 * upload never happens for a path outside the allowed roots (this project's
 * own directory tree, or `HOST_PROJECTS_DIR`/`HOME`), and still happens for
 * a path inside them or a remote URL — the fix has to reject the traversal
 * without breaking the tool's actual purpose.
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

function installPhotoSpy() {
  const calls: { chatId: string; photo: string }[] = [];
  mock.module(TELEGRAM_MODULE, () => ({
    ...PRISTINE,
    sendTelegramPhoto: async (_token: string, chatId: string, photo: string) => {
      calls.push({ chatId, photo });
      return { ok: true, messageId: 1 };
    },
  }));
  return { calls };
}

function restore() {
  mock.module(TELEGRAM_MODULE, () => ({ ...PRISTINE }));
}

afterEach(restore);

/** Registers the real tool handlers and returns the `send_photo` caller. */
async function sendPhotoTool() {
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
    call({ params: { name: "send_photo", arguments: args } });
}

describe("send_photo's local-path allowlist (F-002b)", () => {
  test("a path outside the project and outside HOST_PROJECTS_DIR/HOME is refused — Telegram is never called", async () => {
    const { calls } = installPhotoSpy();
    const sendPhoto = await sendPhotoTool();

    const result = await sendPhoto({ chat_id: CHAT_ID, url: "/etc/passwd" });

    expect(calls).toEqual([]);
    expect(result.content[0]!.text).not.toContain("Photo sent");
    expect(result.content[0]!.text.toLowerCase()).toContain("local path must be within");
  });

  test("a traversal that lexically re-enters the project is still refused", async () => {
    const { calls } = installPhotoSpy();
    const sendPhoto = await sendPhotoTool();

    // `containsPath` resolves before comparing, so a `..`-laden path that
    // lands outside the project is caught the same as a bare absolute path —
    // this is what a `startsWith` check (the bug this replaces) would miss.
    const result = await sendPhoto({ chat_id: CHAT_ID, url: `${PROJECT_PATH}/../../../etc/passwd` });

    expect(calls).toEqual([]);
    expect(result.content[0]!.text.toLowerCase()).toContain("local path must be within");
  });

  test("a path inside the current project is allowed through to Telegram", async () => {
    const { calls } = installPhotoSpy();
    const sendPhoto = await sendPhotoTool();

    const photoPath = `${PROJECT_PATH}/some-chart.png`;
    const result = await sendPhoto({ chat_id: CHAT_ID, url: photoPath });

    expect(calls).toEqual([{ chatId: CHAT_ID, photo: photoPath }]);
    expect(result.content[0]!.text).toContain("Photo sent");
  });

  test("a remote URL is untouched by the local-path check", async () => {
    const { calls } = installPhotoSpy();
    const sendPhoto = await sendPhotoTool();

    const url = "https://example.com/chart.png";
    const result = await sendPhoto({ chat_id: CHAT_ID, url });

    expect(calls).toEqual([{ chatId: CHAT_ID, photo: url }]);
    expect(result.content[0]!.text).toContain("Photo sent");
  });
});

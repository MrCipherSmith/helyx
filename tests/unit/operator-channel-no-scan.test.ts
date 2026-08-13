/**
 * A1.1 / A1.2 — the operator channel is never scanned.
 *
 * Adoption area A1 (`utils/external-boundary-scan.ts`) draws a boundary
 * around every crossing that leaves or enters the process from an untrusted
 * direction — remote TTS, remote transcription, subagent output fed back to
 * the reviewer, and so on. The operator's Telegram chat is not one of those
 * crossings: the operator is inside the trust boundary, the same as the
 * developer at the keyboard. Scanning what reaches them would mean redacting
 * or blocking the very reports the scanner exists to protect them from
 * missing — an AWS key pasted into a bug report, a customer's token quoted
 * back for confirmation, a stack trace with a connection string in it. All of
 * that has to arrive whole, or the channel stops being trustworthy for the
 * one thing it is for.
 *
 * Two independent guards, because a structural check and a behavioural check
 * fail for different reasons and a change that breaks the rule should not be
 * able to sneak past both by accident.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { installFakeTelegram } from "../fixtures/fake-telegram.ts";
import { executeTool } from "../../mcp/tools.ts";
import type { Bot } from "grammy";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("A1.1 — structural: the operator-channel reply handlers never reference the scanner", () => {
  // This is the guard that "fails the moment someone wires the scanner in."
  // It does not exercise any behaviour — it reads the source text of the two
  // files that own the `reply` tool and asserts the scanner's name is not in
  // them. A behavioural test can be worked around by an implementation that
  // only calls the scanner on some code paths; this one cannot be, short of
  // renaming the scanner itself, because it does not care how the call would
  // be reached — it forbids the import and every one of the scanner's public
  // entry points from appearing in the file at all.
  const SCANNER_PATTERN = /external-boundary-scan|guardOutbound|guardInbound|runScan/;

  test("channel/tools.ts (the CLI-side reply handler) does not reference the scanner", async () => {
    const src = await Bun.file(new URL("../../channel/tools.ts", import.meta.url)).text();
    expect(src).not.toMatch(SCANNER_PATTERN);
  });

  test("mcp/tools.ts (the MCP-side reply handler) does not reference the scanner", async () => {
    const src = await Bun.file(new URL("../../mcp/tools.ts", import.meta.url)).text();
    expect(src).not.toMatch(SCANNER_PATTERN);
  });
});

describe("A1.2 — behavioural: an AWS-key-shaped reply is delivered unchanged", () => {
  // Two handlers implement `reply` — channel/tools.ts (used by the CLI
  // subprocess bridge) and mcp/tools.ts's `executeTool` (used by the MCP
  // server bot). channel/tools.ts's reply case is the heavier of the two to
  // drive from a test: before it sends anything it inserts into
  // `pending_replies` and reads `chat_sessions` / `projects`, so exercising
  // it means standing up a FakeSql that answers a specific sequence of
  // queries in the right shape.
  //
  // mcp/tools.ts's `executeTool("reply", ...)` reaches the same
  // `validateReplyGate` call, but the gate itself short-circuits to
  // `{ kind: "allow", mode: "disabled" }` without touching the database
  // whenever `projectPath` is null (see orchestrator/gate.ts) — and
  // `projectPath` is only resolved when the call carries a `_clientId` that
  // maps to a live session. Omitting `_clientId` therefore reaches the real
  // `reply` handler without any database double at all: no FakeSql, no
  // session wiring, just a fake `Bot`. That is the lighter path, so this is
  // the one driven here.
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function fakeBot() {
    const sendRichCalls: { chat_id: number; rich_message: { markdown: string } }[] = [];
    const sendMessageCalls: { chatId: number; text: string }[] = [];
    const bot = {
      api: {
        sendRichMessage: async (payload: { chat_id: number; rich_message: { markdown: string } }) => {
          sendRichCalls.push(payload);
          return {};
        },
        sendMessage: async (chatId: number, msgText: string) => {
          sendMessageCalls.push({ chatId, text: msgText });
          return {};
        },
      },
    } as unknown as Bot;
    return { bot, sendRichCalls, sendMessageCalls };
  }

  test("the text reaches the bot's sendRichMessage verbatim — not redacted, not blocked", async () => {
    // installFakeTelegram is not needed on this path (mcp/tools.ts talks to
    // the injected `bot`, not to channel/telegram.ts) — it is imported here
    // only to prove the network guard from tests/preload.ts is active for
    // the whole file: if the scanner were ever wired in and tried to reach
    // out over the network, installNetworkGuard() makes that throw instead
    // of silently succeeding.
    const { restore } = await installFakeTelegram();
    cleanups.push(restore);

    const { bot, sendRichCalls } = fakeBot();
    const replyText = `Found a leaked credential in the log: ${AWS_KEY}`;

    const result = await executeTool("reply", { chat_id: "-1001234", text: replyText }, bot);

    expect(sendRichCalls.length).toBe(1);
    expect(sendRichCalls[0]!.rich_message.markdown).toBe(replyText);
    expect(sendRichCalls[0]!.rich_message.markdown).toContain(AWS_KEY);
    expect(result.content[0]!.text).toContain("Sent to chat");
  });

  test("even if the rich path is unavailable, the plain-send fallback still delivers the key unchanged", async () => {
    // Covers the other of the two delivery branches in the handler — the
    // guarantee has to hold on both, not just on whichever one the JSON API
    // happens to support.
    const { restore } = await installFakeTelegram();
    cleanups.push(restore);

    const sendMessageCalls: { chatId: number; text: string }[] = [];
    const bot = {
      api: {
        sendRichMessage: async () => {
          throw new Error("rich message not supported");
        },
        sendMessage: async (chatId: number, msgText: string) => {
          sendMessageCalls.push({ chatId, text: msgText });
          return {};
        },
      },
    } as unknown as Bot;

    const replyText = `Rotate this immediately: ${AWS_KEY}`;
    await executeTool("reply", { chat_id: "-1001234", text: replyText }, bot);

    expect(sendMessageCalls.length).toBeGreaterThan(0);
    const delivered = sendMessageCalls.map((c) => c.text).join("");
    expect(delivered).toContain(AWS_KEY);
  });
});

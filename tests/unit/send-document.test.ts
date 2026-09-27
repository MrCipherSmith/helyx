import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendTelegramDocument } from "../../channel/telegram.ts";
import { channelLogger } from "../../logger.ts";
import { createLocalAllowance, setSharedAllowanceForTests } from "../../utils/telegram-rate-budget.ts";

/**
 * A document has to arrive as a document.
 *
 * The bug this guards: `sendPhoto` is the only upload endpoint the channel had,
 * and a PDF sent to it is accepted, acknowledged with a message id, and then
 * never reaches the recipient as a file they can open. Everything looked fine
 * from the sending side — the tool even reported "Photo sent" — which is why
 * the assertion that matters here is not "the call succeeded" but "the request
 * was a `sendDocument` carrying this file's own name and bytes".
 *
 * These tests drive the real `sendTelegramDocument`, so they also pin the
 * contract it inherits from `telegramRequest`: the shared rate budget
 * (flow 064) and the thread-miss check (a send into a deleted topic is filed
 * into General, silently, unless something notices).
 */

const TOKEN = "test-token";
const CHAT = "-1003908750902";

let requests: { url: string; body: unknown }[];
let realFetch: typeof fetch;
let realError: typeof channelLogger.error;
let errors: Array<Record<string, unknown>>;
let restoreAllowance: () => void;
let testAllowance: ReturnType<typeof createLocalAllowance>;
let dir: string;

/** Answer every call the way Telegram would, recording what was asked. */
function stubTelegram(result: unknown = { message_id: 700 }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body });
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function documentIn(body: unknown): File {
  // The multipart body is the whole point of the call — a test that only
  // counted requests would pass against a request carrying no file at all.
  return (body as FormData).get("document") as File;
}

beforeEach(() => {
  requests = [];
  errors = [];
  realFetch = globalThis.fetch;
  realError = channelLogger.error;
  (channelLogger as any).error = (obj: unknown) => {
    errors.push((obj ?? {}) as Record<string, unknown>);
  };
  // Same reasoning as telegram-thread-miss.test.ts: the real allowance talks
  // to a Postgres row on a lease window, and this file is about neither.
  testAllowance = createLocalAllowance({ lease: async () => ({ granted: 1_000 }) });
  restoreAllowance = setSharedAllowanceForTests("priority", testAllowance);
  dir = mkdtempSync(join(tmpdir(), "helyx-document-"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (channelLogger as any).error = realError;
  testAllowance.stop();
  restoreAllowance();
  rmSync(dir, { recursive: true, force: true });
});

describe("sendTelegramDocument", () => {
  test("posts to sendDocument, keeping the file's own name and type", async () => {
    stubTelegram();
    const path = join(dir, "next-sprint-plan.pdf");
    writeFileSync(path, "%PDF-1.4\nbody\n%%EOF\n");

    const res = await sendTelegramDocument(TOKEN, CHAT, path, "plan for stage 18");

    expect(res.ok).toBe(true);
    expect(res.messageId).toBe(700);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendDocument`);

    const form = requests[0]!.body as FormData;
    expect(form.get("chat_id")).toBe(CHAT);
    expect(form.get("caption")).toBe("plan for stage 18");

    const file = documentIn(requests[0]!.body);
    // Not `photo`, and not an extension-less blob: the recipient has to be able
    // to see what they were sent before they open it.
    expect(file.name).toBe("next-sprint-plan.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toContain("%PDF-1.4");
  });

  test("an unnamed or untyped file still uploads as an octet-stream", async () => {
    stubTelegram();
    const path = join(dir, "no-extension");
    writeFileSync(path, "raw");

    await sendTelegramDocument(TOKEN, CHAT, path);

    const file = documentIn(requests[0]!.body);
    expect(file.name).toBe("no-extension");
    expect(file.type).toBe("application/octet-stream");
  });

  test("a missing file fails without calling Telegram", async () => {
    stubTelegram();

    const res = await sendTelegramDocument(TOKEN, CHAT, join(dir, "absent.pdf"));

    expect(res.ok).toBe(false);
    expect(res.errorBody).toContain("File not found");
    expect(requests).toEqual([]);
  });

  test("an empty file fails without calling Telegram", async () => {
    stubTelegram();
    const path = join(dir, "empty.pdf");
    writeFileSync(path, "");

    const res = await sendTelegramDocument(TOKEN, CHAT, path);

    // Zero bytes is the one upload Telegram would happily accept and the
    // recipient would receive as nothing.
    expect(res.ok).toBe(false);
    expect(res.errorBody).toContain("File is empty");
    expect(requests).toEqual([]);
  });

  test("a caption past Telegram's limit is refused here, not by the API", async () => {
    stubTelegram();

    const res = await sendTelegramDocument(TOKEN, CHAT, join(dir, "x.pdf"), "y".repeat(1025));

    expect(res.ok).toBe(false);
    expect(res.errorBody).toContain("1024");
    expect(requests).toEqual([]);
  });

  test("a document landing outside its topic is reported, like any other send", async () => {
    // Telegram accepts a send into a deleted topic and files it in General.
    stubTelegram({ message_id: 701 });
    const path = join(dir, "plan.pdf");
    writeFileSync(path, "%PDF-1.4\n%%EOF\n");

    await sendTelegramDocument(TOKEN, CHAT, path, undefined, { message_thread_id: 1159 });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.requestedThread).toBe(1159);
    expect(errors[0]!.landedIn).toBe("General");
  });
});

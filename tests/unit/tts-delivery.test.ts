/**
 * Which replies are spoken, how they are cut up, and what leaves the process.
 *
 * The chain that produces the audio is covered in `tts-chain.test.ts`. This is
 * the other half: the decisions before it — is this text worth speaking at all,
 * and if it is too long for one message, where does it break — and the delivery
 * after it.
 *
 * Both matter to the operator directly. A wrong answer to the first means a
 * page of code read aloud; a wrong answer to the second means a voice message
 * cut mid-word.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { shouldSendVoice, splitForVoice, sendOneVoice } from "../../utils/tts.ts";
import { CONFIG } from "../../config.ts";

const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
const settings = CONFIG as { TTS_PROVIDER: string };
const realProvider = settings.TTS_PROVIDER;

afterEach(() => {
  globalThis.fetch = realFetch;
  (Bun as { spawn: unknown }).spawn = realSpawn;
  settings.TTS_PROVIDER = realProvider;
});

/** Piper is a real binary present in this checkout — left alone it would speak. */
function silencePiper(): void {
  (Bun as { spawn: unknown }).spawn = (() => ({ exited: Promise.resolve(1) })) as unknown as typeof Bun.spawn;
}

const prose = (n: number) => "Проверил очередь и перезапустил контейнер. ".repeat(n);

describe("what is worth speaking", () => {
  test("something too short to be worth a voice message", () => {
    expect(shouldSendVoice("Готово")).toBe(false);
  });

  test("ordinary prose is spoken", () => {
    expect(shouldSendVoice(prose(10))).toBe(true);
  });

  test("a reply that is mostly a code block is not read aloud", () => {
    // A fenced block read by a voice model is unusable: the operator hears
    // punctuation names for a minute.
    const code = "```\n" + "const x = 1;\n".repeat(40) + "```";
    const text = `Вот исправление:\n\n${code}`;

    expect(shouldSendVoice(text)).toBe(false);
  });

  test("a diff is not read aloud either", () => {
    const diff = [
      "-const a = 1;",
      "+const a = 2;",
      "-const b = 3;",
      "+const b = 4;",
      "-const c = 5;",
      "+const c = 6;",
    ].join("\n");

    expect(shouldSendVoice(`${prose(12)}\n${diff}`)).toBe(false);
  });

  test("a markdown bullet list is not mistaken for a diff", () => {
    // The distinction is the space: "- item" is prose, "-removed" is a diff.
    const bullets = ["- проверил очередь", "- перезапустил бота", "- посмотрел логи"].join("\n");

    expect(shouldSendVoice(`${prose(12)}\n${bullets}`)).toBe(true);
  });
});

describe("cutting a long reply into voice messages", () => {
  test("something that fits is one piece, trimmed", () => {
    expect(splitForVoice("  Коротко и по делу  ", 60)).toEqual(["Коротко и по делу"]);
  });

  test("a long text is split, and nothing is lost", () => {
    const text = prose(60);

    const pieces = splitForVoice(text, 30);

    expect(pieces.length).toBeGreaterThan(1);
    // Every character of the original survives somewhere, modulo the
    // whitespace at the joins.
    const rejoined = pieces.join(" ").replace(/\s+/g, " ").trim();
    expect(rejoined).toBe(text.replace(/\s+/g, " ").trim());
  });

  test("a paragraph boundary is preferred to a mid-sentence cut", () => {
    const first = "Первый абзац про очередь и про то, что она снова разбирается.";
    const second = "Второй абзац про контейнер, который пришлось перезапустить.";

    const pieces = splitForVoice(`${first}\n\n${second}`, 5);

    expect(pieces[0]).toBe(first);
  });

  test("no piece exceeds the budget by more than the last word", () => {
    const pieces = splitForVoice(prose(40), 20);
    const budget = Math.floor(20 * 15); // VOICE_CHARS_PER_SECOND

    for (const piece of pieces.slice(0, -1)) {
      expect(piece.length).toBeLessThanOrEqual(budget);
    }
  });
});

describe("sending one voice message", () => {
  interface Sent { urls: string[]; multipart: number }

  function stub(options: { fail?: boolean } = {}): Sent {
    const sent: Sent = { urls: [], multipart: 0 };
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const target = String(url);
      sent.urls.push(target);
      if (init?.body instanceof FormData) sent.multipart++;

      if (target.includes("/chat/completions")) {
        return Response.json({ choices: [{ message: { content: "Перезапустил контейнер бота" } }] });
      }
      if (target.includes("sendVoice")) {
        return options.fail
          ? new Response("nope", { status: 400 })
          : Response.json({ ok: true, result: { message_id: 1 } });
      }
      // Every voice provider refuses, so synthesis returns null.
      return new Response("no", { status: 503 });
    }) as unknown as typeof fetch;
    return sent;
  }

  test("nothing is uploaded when there is no audio to upload", async () => {
    // Every provider refused. The operator gets no voice message, and the
    // caller is not told about it — the text has already been delivered.
    settings.TTS_PROVIDER = "auto";
    silencePiper();
    const sent = stub();

    await expect(sendOneVoice("token", "-100", prose(4))).resolves.toBeUndefined();

    expect(sent.urls.some((u) => u.includes("sendVoice"))).toBe(false);
  });

  test("a Telegram rejection is swallowed rather than thrown at the caller", async () => {
    // This runs after a reply the operator has already received. Failing it
    // loudly would turn a missing voice note into a failed turn.
    settings.TTS_PROVIDER = "none";
    silencePiper();
    stub({ fail: true });

    await expect(sendOneVoice("token", "-100", prose(4))).resolves.toBeUndefined();
  });
});

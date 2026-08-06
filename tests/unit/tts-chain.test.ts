/**
 * The chain the operator actually hears.
 *
 * Every reply over 300 characters is spoken, so this runs on almost every
 * message — and for a long time it failed its first provider on every one of
 * them: `tts: Yandex error` with a 401, the chain falling through to Piper, and
 * the operator hearing the second provider without anything saying so. The
 * fallback was load-bearing in production and untested here.
 *
 * Piper is first now, and the fallback these tests exist for runs the other
 * way: Yandex is what answers when the local model does not.
 *
 * `synthesize` reaches the world through exactly two doors — `fetch` for the
 * HTTP providers and the normalizer, `Bun.spawn` for Piper — so both are
 * replaced and the whole decision surface is driven without a network or a
 * voice model. Which providers are reachable at all is decided by credentials
 * read at import; `tests/preload.ts` pins those, so this file describes the
 * same chain on every machine.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { synthesize } from "../../utils/tts.ts";
import { CONFIG } from "../../config.ts";

const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
// `CONFIG` is typed read-only and is a plain object at runtime. The cast is
// the honest way to say "this test changes a setting and puts it back".
const settings = CONFIG as { TTS_PROVIDER: string };
const realProvider = settings.TTS_PROVIDER;

/** Long enough to be spoken, and unambiguously Russian. */
const RUSSIAN = "Перезапустил контейнер бота и проверил, что очередь снова разбирается";
/** Long enough to be spoken, and unambiguously English. */
const ENGLISH = "Restarted the bot container and confirmed the queue is draining again";

interface Doors {
  /** Every URL fetched, in order. */
  urls: string[];
  /**
   * Which voices were tried, in the order they were tried.
   *
   * `urls` cannot answer that question: Piper is a subprocess, not a request,
   * so it leaves no entry there — and "Piper before Yandex" is precisely what
   * this file has to be able to assert.
   */
  tried: string[];
  /** What each provider was asked to say. */
  spoken: { yandex?: string; groq?: string; kokoro?: string; piper?: string };
  /** Whether Piper was asked to run. */
  piperRuns: number;
}

let doors: Doors;

/** Which providers answer, and what the normalizer returns. */
interface Script {
  yandex?: "ok" | "fail";
  groq?: "ok" | "fail";
  kokoro?: "ok" | "fail";
  piper?: "ok" | "fail";
  /** The normalizer's answer; `undefined` leaves the text alone. */
  normalized?: string;
}

function install(script: Script): void {
  doors = { urls: [], tried: [], spoken: {}, piperRuns: 0 };

  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const target = String(url);
    doors.urls.push(target);
    // Parsed lazily and safely: Yandex is form-encoded, the rest are JSON, and
    // parsing eagerly threw on the very first provider in the chain.
    const asJson = (): Record<string, unknown> => {
      try { return init?.body ? JSON.parse(init.body) : {}; } catch { return {}; }
    };

    // The normalizer — a chat completion, not a voice endpoint.
    if (target.includes("/chat/completions")) {
      const text = String((asJson().messages as Array<{ content?: string }> | undefined)?.at(-1)?.content ?? "");
      const said = script.normalized ?? text.split("\n\n").at(-1) ?? text;
      return Response.json({ choices: [{ message: { content: said } }] });
    }

    if (target.includes("tts.api.cloud.yandex.net")) {
      doors.tried.push("yandex");
      doors.spoken.yandex = String(new URLSearchParams(init?.body ?? "").get("text") ?? init?.body ?? "");
      if (script.yandex !== "ok") return new Response("unauthorized", { status: 401 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }

    if (target.includes("groq")) {
      doors.tried.push("groq");
      doors.spoken.groq = String(asJson().input ?? "");
      if (script.groq !== "ok") return new Response("no", { status: 503 });
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    }

    // Anything else is Kokoro or another local voice endpoint.
    doors.tried.push("kokoro");
    doors.spoken.kokoro = String(asJson().input ?? asJson().text ?? "");
    if (script.kokoro !== "ok") return new Response("no", { status: 503 });
    return Response.json({ audio: [0.1, 0.2, 0.3] });
  }) as unknown as typeof fetch;

  // Piper writes a wav to the path it is given. The stub does the same, because
  // a stub that only reports an exit code would prove the binary was called
  // rather than that sound came back.
  (Bun as { spawn: unknown }).spawn = ((argv: string[], options?: { stdin?: Uint8Array }) => {
    doors.tried.push("piper");
    doors.piperRuns++;
    doors.spoken.piper = options?.stdin ? new TextDecoder().decode(options.stdin) : "";
    const out = argv[argv.indexOf("--output_file") + 1];
    if (script.piper === "ok" && out) writeFileSync(out, Buffer.from([7, 8, 9]));
    return { exited: Promise.resolve(script.piper === "ok" ? 0 : 1) };
  }) as unknown as typeof Bun.spawn;
}

beforeEach(() => { install({}); });

afterEach(() => {
  globalThis.fetch = realFetch;
  (Bun as { spawn: unknown }).spawn = realSpawn;
  settings.TTS_PROVIDER = realProvider;
});

describe("nothing to say", () => {
  test("text too short to be worth speaking", async () => {
    expect(await synthesize("ок")).toBeNull();
    expect(doors.urls).toEqual([]);
  });

  test("voice turned off", async () => {
    settings.TTS_PROVIDER = "none";

    expect(await synthesize(RUSSIAN)).toBeNull();
    expect(doors.urls).toEqual([]);
  });
});

describe("the chain", () => {
  test("Piper answers, and nothing is spent on a provider", async () => {
    settings.TTS_PROVIDER = "auto";
    // Yandex would answer if it were asked. It must not be asked.
    install({ piper: "ok", yandex: "ok" });

    const result = await synthesize(RUSSIAN);

    expect(result?.fmt).toBe("wav");
    // The bytes the stub wrote to the output path, read back through the real
    // code. Raised in review: without this the test proves a binary was called
    // and an exit code was zero, not that audio came back.
    expect([...(result?.buf ?? [])]).toEqual([7, 8, 9]);
    expect(doors.spoken.yandex).toBeUndefined();
  });

  test("Piper goes quiet and Yandex answers — the fallback, in the direction it now runs", async () => {
    settings.TTS_PROVIDER = "auto";
    install({ piper: "fail", yandex: "ok" });

    const result = await synthesize(RUSSIAN);

    expect(result?.fmt).toBe("mp3");
    expect([...(result?.buf ?? [])]).toEqual([1, 2, 3]); // Yandex's bytes, not another provider's
    expect(doors.piperRuns).toBe(1); // it was tried first
  });

  test("both fail and the chain still reaches the third provider", async () => {
    settings.TTS_PROVIDER = "auto";
    install({ piper: "fail", yandex: "fail", groq: "ok" });

    const result = await synthesize(RUSSIAN);

    expect(result?.fmt).toBe("wav");
    expect([...(result?.buf ?? [])]).toEqual([4, 5, 6]); // the third provider's bytes
    expect(doors.spoken.groq).toBeTruthy();
  });

  test("everything fails and the answer is silence, not a crash", async () => {
    settings.TTS_PROVIDER = "auto";
    install({ piper: "fail", yandex: "fail", groq: "fail" });

    await expect(synthesize(RUSSIAN)).resolves.toBeNull();
  });
});

describe("language decides the order", () => {
  test("English never asks the Russian-first provider", async () => {
    settings.TTS_PROVIDER = "auto";
    install({ piper: "ok" });

    const result = await synthesize(ENGLISH);

    expect(result?.fmt).toBe("wav");
    expect(doors.urls.some((u) => u.includes("yandex"))).toBe(false);
  });

  test("Russian tries Piper before Yandex, and only then", async () => {
    // The order itself, asserted rather than inferred from which bytes came
    // back: both providers answer here, so a chain that ran them the other way
    // round would still return audio and still look like a pass.
    settings.TTS_PROVIDER = "auto";
    install({ piper: "fail", yandex: "ok" });

    await synthesize(RUSSIAN);

    expect(doors.tried.filter((t) => t === "piper" || t === "yandex")).toEqual(["piper", "yandex"]);
  });
});

describe("what the voice is actually given", () => {
  test("a normalizer that answers in the wrong language is discarded", async () => {
    // The guard exists because a normalizer once translated instead of
    // normalizing: `--build bot` came back as `--строить бот`, a different
    // command read out to the operator.
    settings.TTS_PROVIDER = "auto";
    install({ piper: "ok", normalized: "Restarted the container and drained the queue" });

    await synthesize(RUSSIAN);

    // The English normalization is thrown away and the stripped Russian is
    // spoken instead.
    expect(doors.spoken.piper).toContain("Перезапустил");
  });

  test("Latin the normalizer leaves behind is cyrillized before it is spoken", async () => {
    // The Russian voice has no Latin phonemes: a Latin word that reaches it is
    // silence or noise, so the prompt asks and this guarantees.
    settings.TTS_PROVIDER = "auto";
    install({ piper: "ok", normalized: "Перезапустил docker и проверил очередь заново" });

    await synthesize(RUSSIAN);

    expect(doors.spoken.piper).not.toContain("docker");
    expect(doors.spoken.piper).toContain("докер");
  });
});

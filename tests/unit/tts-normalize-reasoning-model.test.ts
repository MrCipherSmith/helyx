/**
 * The TTS normalizer's two providers (Groq, then an OpenRouter-shaped
 * fallback) are both reasoning models, and both have the same failure mode: a
 * reasoning model asked for a short rewrite will spend its whole token budget
 * on hidden reasoning and return empty content unless `reasoning_effort` tells
 * it not to. The Groq call already carried this fix; the fallback did not —
 * confirmed live, 100% reproducible, for any input length — so every voice
 * reply fell through to raw, un-normalized text the moment Groq's model name
 * also went stale (qwen/qwen3.6-27b was retired from Groq's catalog).
 *
 * This pins both: the Groq call uses a model that actually exists, and the
 * fallback call carries the same `reasoning_effort: "none"` the Groq call
 * does.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { synthesize } from "../../utils/tts.ts";
import { CONFIG } from "../../config.ts";

const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
const realWhich = Bun.which;
const settings = CONFIG as { TTS_PROVIDER: string; OPENROUTER_API_KEY: string };
const realProvider = settings.TTS_PROVIDER;
const realOpenRouterKey = settings.OPENROUTER_API_KEY;

/** Retired from Groq's catalog — a request naming it gets a 404. */
const DEAD_GROQ_MODEL = "qwen/qwen3.6-27b";

const RUSSIAN = "Перезапустил контейнер бота и проверил, что очередь снова разбирается";

interface Captured {
  groqBody?: Record<string, unknown>;
  fallbackBody?: Record<string, unknown>;
}

/**
 * Stubs fetch and Piper exactly like tts-chain.test.ts, but distinguishes the
 * Groq normalizer call from the OpenRouter-shaped fallback by host — the two
 * matter separately here, which the existing harness's single catch-all
 * `/chat/completions` branch does not need to tell apart.
 *
 * `groqFails`, when true, 404s Groq unconditionally — reaching the fallback
 * the way production does whenever Groq is unavailable for any reason, not
 * only the one dead-model-name reason the other test pins.
 */
function install(options: { groqFails?: boolean } = {}): Captured {
  const captured: Captured = {};

  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const target = String(url);
    const body = (): Record<string, unknown> => {
      try { return init?.body ? JSON.parse(init.body) : {}; } catch { return {}; }
    };

    if (target.includes("api.groq.com") && target.includes("/chat/completions")) {
      const parsed = body();
      captured.groqBody = parsed;
      if (options.groqFails || parsed.model === DEAD_GROQ_MODEL) {
        return new Response(
          JSON.stringify({ error: { message: `The model \`${parsed.model}\` does not exist or you do not have access to it.`, code: "model_not_found" } }),
          { status: 404 },
        );
      }
      return Response.json({ choices: [{ message: { content: "Перезапустил докер-контейнер бота" } }] });
    }

    if (target.includes("/chat/completions")) {
      // The OpenRouter-shaped fallback (this deployment points it at DeepSeek).
      captured.fallbackBody = body();
      return Response.json({ choices: [{ message: { content: "Перезапустил докер-контейнер бота (резерв)" } }] });
    }

    return new Response("no", { status: 503 });
  }) as unknown as typeof fetch;

  (Bun as { which: unknown }).which = ((bin: string) =>
    bin === "keryx" ? null : realWhich(bin)) as unknown as typeof Bun.which;

  (Bun as { spawn: unknown }).spawn = ((argv: string[]) => {
    const out = argv[argv.indexOf("--output_file") + 1];
    if (out) writeFileSync(out, Buffer.from([1, 2, 3]));
    return { exited: Promise.resolve(0) };
  }) as unknown as typeof Bun.spawn;

  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  (Bun as { spawn: unknown }).spawn = realSpawn;
  (Bun as { which: unknown }).which = realWhich;
  settings.TTS_PROVIDER = realProvider;
  settings.OPENROUTER_API_KEY = realOpenRouterKey;
});

describe("the TTS normalizer's two reasoning-model providers", () => {
  test("the Groq call no longer names the retired model", async () => {
    settings.TTS_PROVIDER = "auto";
    const captured = install();

    await synthesize(RUSSIAN);

    expect(captured.groqBody?.model).not.toBe(DEAD_GROQ_MODEL);
    expect(captured.groqBody?.reasoning_effort).toBe("none");
  });

  test("the OpenRouter-shaped fallback also sets reasoning_effort: none", async () => {
    settings.TTS_PROVIDER = "auto";
    // tests/preload.ts zeroes this for determinism elsewhere; this test is
    // specifically about the path it gates.
    settings.OPENROUTER_API_KEY = "test-openrouter-key";
    const captured = install({ groqFails: true });

    await synthesize(RUSSIAN);

    // This only proves something if the fallback was actually reached.
    expect(captured.fallbackBody).toBeDefined();
    expect(captured.fallbackBody?.reasoning_effort).toBe("none");
  });
});

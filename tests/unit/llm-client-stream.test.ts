/**
 * The reader loops themselves, driven end to end against a fake network.
 *
 * The decisions inside them live in `utils/llm-stream.ts` and are tested there.
 * This is the other half: that the loop assembles a response body into those
 * decisions correctly — decoding bytes, carrying a partial line across reads,
 * stopping where it should — which is the part no unit of pure logic can prove.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openaiStream, ollamaStream, openaiGenerate, withRetry } from "../../claude/client.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";

let http: FakeFetch;
let restore: () => void;

beforeEach(() => {
  ({ http, restore } = installFakeFetch());
});

afterEach(() => restore());

/**
 * Answer the next request with this body, in these pieces.
 *
 * The recording fake still sees the request — so a test can assert on what was
 * sent — but the response is built here, because a streamed body arriving in
 * chosen pieces is the whole point and the fixture only serves whole values.
 */
function serveBytes(chunks: Uint8Array[], status = 200) {
  const recorder = http.fetch;
  http.program("", { json: {} });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Not swallowed: the recorder is what lets a test see the request, and an
    // error from it means the request went somewhere nobody described.
    await recorder(input, init);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status },
    );
  }) as typeof globalThis.fetch;
}

function serve(_match: string, chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  serveBytes(chunks.map((c) => encoder.encode(c)), status);
}

function serveJson(value: unknown, status = 200) {
  const encoder = new TextEncoder();
  serveBytes([encoder.encode(JSON.stringify(value))], status);
}

/** Where `needle` starts inside `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

async function collect(stream: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const piece of stream) out += piece;
  return out;
}

describe("the OpenAI-compatible stream", () => {
  test("assembles the deltas into an answer", async () => {
    serve("", [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":", world"}}]}\n',
      "data: [DONE]\n",
    ]);

    expect(await collect(openaiStream([{ role: "user", content: "hi" }], "be brief"))).toBe("Hello, world");

    // And it asked the right thing of the right endpoint, once. Without this
    // the suite passes with a wrong URL, a wrong method, or a system prompt
    // that never reached the model.
    expect(http.requests).toHaveLength(1);
    const request = http.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toEndWith("/chat/completions");
    const body = request.body as { stream?: boolean; messages?: { role: string; content: string }[] };
    expect(body.stream).toBe(true);
    expect(body.messages?.[0]).toEqual({ role: "system", content: "be brief" });
    expect(body.messages?.[1]).toEqual({ role: "user", content: "hi" });
  });

  test("an event split across two reads is not lost", async () => {
    // The reason the loop carries a buffer at all. A body arrives in whatever
    // pieces the socket produced, and almost none of them end on a newline.
    serve("", [
      'data: {"choices":[{"delta":{"con',
      'tent":"split"}}]}\n',
      "data: [DONE]\n",
    ]);

    expect(await collect(openaiStream([{ role: "user", content: "hi" }], ""))).toBe("split");
  });

  test("a multi-byte character split across two reads survives", async () => {
    // The decoder is stateful for exactly this: "…" is three bytes, and a read
    // can end between them.
    //
    // The split point is found rather than guessed. The first version of this
    // test took the last two bytes of the line — which are "}" and "\n", both
    // ASCII — so it split nothing and would have passed with the decoder
    // removed entirely.
    const line = 'data: {"choices":[{"delta":{"content":"жду…"}}]}\n';
    const encoded = new TextEncoder().encode(line);
    const ellipsis = new TextEncoder().encode("…");
    const at = indexOfBytes(encoded, ellipsis);
    expect(at).toBeGreaterThan(0);

    // One byte into the three-byte character.
    serveBytes([encoded.slice(0, at + 1), encoded.slice(at + 1)]);

    expect(await collect(openaiStream([{ role: "user", content: "hi" }], ""))).toBe("жду…");
  });

  test("a CRLF stream still ends where it says it does", async () => {
    // SSE is specified with CRLF and several providers send it. Left in place,
    // the terminator arrives as "[DONE]\r" — not the terminator — and the
    // reader carries on emitting whatever follows.
    serve("", [
      'data: {"choices":[{"delta":{"content":"answer"}}]}\r\n',
      "data: [DONE]\r\n",
      'data: {"choices":[{"delta":{"content":"trailing"}}]}\r\n',
    ]);

    expect(await collect(openaiStream([{ role: "user", content: "hi" }], ""))).toBe("answer");
  });

  test("everything after [DONE] is ignored", async () => {
    serve("", [
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
      "data: [DONE]\n",
      'data: {"choices":[{"delta":{"content":"trailing"}}]}\n',
    ]);

    expect(await collect(openaiStream([{ role: "user", content: "hi" }], ""))).toBe("answer");
  });

  test("keep-alives and a malformed chunk cost nothing", async () => {
    // A provider sends comments to hold the connection open, and a truncated
    // chunk should cost that chunk rather than the answer.
    serve("", [
      ": keep-alive\n",
      "\n",
      "data: {oops\n",
      'data: {"choices":[{"delta":{"content":"still here"}}]}\n',
      "data: [DONE]\n",
    ]);

    expect(await collect(openaiStream([{ role: "user", content: "hi" }], ""))).toBe("still here");
  });

  test("usage from the final chunk reaches the caller's object", async () => {
    // Streaming providers report tokens once, at the end. The counts are what
    // the cost tracking is built on.
    serve("", [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
      'data: {"usage":{"prompt_tokens":11,"completion_tokens":22},"choices":[]}\n',
      "data: [DONE]\n",
    ]);

    const usage: { input?: number; output?: number } = {};
    await collect(openaiStream([{ role: "user", content: "hi" }], "", usage));
    expect(usage).toEqual({ input: 11, output: 22 });
  });

  test("a rejected request is an error, not an empty answer", async () => {
    // Silently returning nothing would look like a model with nothing to say.
    //
    // 401 rather than 500 on purpose: a 5xx is retried three times with
    // exponential backoff — correct in production, fourteen seconds in a test.
    // The retry policy itself is covered in utils/llm-stream.ts, where it costs
    // nothing.
    serve("", ["bad key"], 401);

    await expect(collect(openaiStream([{ role: "user", content: "hi" }], ""))).rejects.toThrow(/API failed: 401/);
  });
});

describe("the Ollama stream", () => {
  test("assembles newline-delimited chunks", async () => {
    serve("", [
      '{"message":{"content":"Hel"}}\n',
      '{"message":{"content":"lo"}}\n',
      '{"done":true}\n',
    ]);

    expect(await collect(ollamaStream([{ role: "user", content: "hi" }], ""))).toBe("Hello");

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toEndWith("/api/chat");
    // `think: false` asks the model not to produce a reasoning block at all.
    // The filter is the fallback for models that ignore it, not the plan.
    expect((http.requests[0]!.body as { think?: boolean }).think).toBe(false);
  });

  test("a reasoning block is hidden even when its tag is split across reads", async () => {
    // The case the whole filter exists for, exercised through the real loop
    // rather than by handing the filter the pieces directly.
    serve("", [
      '{"message":{"content":"<"}}\n{"message":{"content":"th"}}\n',
      '{"message":{"content":"ink>working</think>"}}\n',
      '{"message":{"content":"answer"}}\n',
    ]);

    expect(await collect(ollamaStream([{ role: "user", content: "hi" }], ""))).toBe("answer");
  });

  test("a short reply that never resolves the ambiguity is still delivered", async () => {
    // "ok" is a complete answer. Dropping it because it might have become
    // "<think>" is how the previous implementation lost whole responses.
    serve("", ['{"message":{"content":"<t"}}\n']);

    expect(await collect(ollamaStream([{ role: "user", content: "hi" }], ""))).toBe("<t");
  });

  test("a refusal from Ollama is an error", async () => {
    serve("", ["model not loaded"], 503);

    await expect(collect(ollamaStream([{ role: "user", content: "hi" }], ""))).rejects.toThrow(/Ollama chat failed: 503/);
  });
});

describe("the non-streaming path", () => {
  test("returns the content with its token counts, reasoning removed", async () => {
    serveJson({
      choices: [{ message: { content: "<think>weighing</think>The answer" } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    });

    expect(await openaiGenerate([{ role: "user", content: "hi" }], "")).toEqual({
      content: "The answer",
      inputTokens: 5,
      outputTokens: 7,
    });
  });
});


describe("withRetry — the loop, not just its predicate", () => {
  test("a transient failure is retried and then succeeds", async () => {
    // The pure predicate and the backoff are asserted elsewhere. This is the
    // wiring: that the loop actually consults them, waits, and tries again.
    const waits: number[] = [];
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("API failed: 503 Service Unavailable");
        return "answer";
      },
      "test",
      async (ms) => { waits.push(ms); },
    );

    expect(result).toBe("answer");
    expect(attempts).toBe(3);
    expect(waits).toHaveLength(2);
    // Exponential: the second wait is about twice the first, jitter aside.
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  test("a permanent failure is not retried at all", async () => {
    // Retrying a bad key three times only delays the error by fourteen seconds.
    const waits: number[] = [];
    let attempts = 0;

    await expect(
      withRetry(
        async () => { attempts++; throw new Error("401 Unauthorized"); },
        "test",
        async (ms) => { waits.push(ms); },
      ),
    ).rejects.toThrow("401");

    expect(attempts).toBe(1);
    expect(waits).toHaveLength(0);
  });

  test("a failure that never clears gives up after the budget", async () => {
    const waits: number[] = [];
    let attempts = 0;

    await expect(
      withRetry(
        async () => { attempts++; throw new Error("429 Too Many Requests"); },
        "test",
        async (ms) => { waits.push(ms); },
      ),
    ).rejects.toThrow("429");

    // Four calls: the first, plus MAX_RETRIES more.
    expect(attempts).toBe(4);
    expect(waits).toHaveLength(3);
  });
});

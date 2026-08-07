/**
 * The proxy's routing, and the two behaviours that decide whether a session
 * starts at all: which model gets run, and what an unreachable Ollama looks
 * like from the terminal.
 *
 * The daemon half (`Bun.serve`, the heartbeat) is not exercised here — `route()`
 * is exported precisely so the request handling can be tested without a socket
 * or a database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { route } from "../../scripts/ollama-proxy.ts";
import { parseModelsResponse } from "../../services/provider-service.ts";
import { ollamaProxyEnabled, ollamaProxyPort, DEFAULT_OLLAMA_PROXY_PORT } from "../../utils/ollama-proxy-settings.ts";
import { CONFIG } from "../../config.ts";

let http: FakeFetch;
let restore: () => void;

const TAGS = { models: [{ model: "geekom-model-1:latest" }, { model: "gemma4:e2b" }] };
const SHOW = { model_info: { "qwen3.context_length": 40960 } };

function post(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:3458${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  ({ http, restore } = installFakeFetch());
  http.program("/api/tags", { json: TAGS });
  http.program("/api/show", { json: SHOW });
});

afterEach(() => restore());

describe("routing", () => {
  test("an unknown route names itself rather than answering a bare 404", async () => {
    const res = await route(new Request("http://127.0.0.1:3458/v1/complete"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("not_found_error");
    expect(body.error.message).toContain("/v1/complete");
  });

  test("/health answers without touching Ollama", async () => {
    const res = await route(new Request("http://127.0.0.1:3458/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  test("/v1/models returns what the provider add-flow can parse", async () => {
    // This route exists for exactly one caller: fetchProviderModels() during
    // `/providers → ➕ Add → Custom`. Anything it cannot parse leaves the
    // operator typing model names by hand.
    const res = await route(new Request("http://127.0.0.1:3458/v1/models"));
    expect(parseModelsResponse(await res.json())).toEqual([
      { id: "geekom-model-1:latest", label: "geekom-model-1:latest" },
      { id: "gemma4:e2b", label: "gemma4:e2b" },
    ]);
  });

  test("count_tokens returns a number and admits it is an estimate", async () => {
    const res = await route(
      post("/v1/messages/count_tokens", { messages: [{ role: "user", content: "hello there" }] }),
    );
    const body = await res.json();
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(body.estimated).toBe(true);
  });
});

describe("/v1/messages", () => {
  test("a non-streaming turn is translated in both directions", async () => {
    http.program("/api/chat", {
      json: { message: { content: "hi" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 1 },
    });

    const res = await route(
      post("/v1/messages", {
        model: "geekom-model-1",
        system: "be terse",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
      }),
    );

    const sent = http.last("/api/chat")?.body as any;
    expect(sent.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(sent.tools[0].function.name).toBe("Bash");
    // The context window comes from the model, not from a guess.
    expect(sent.options.num_ctx).toBe(40960);

    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.content[0]).toEqual({ type: "text", text: "hi" });
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 1 });
  });

  test("a streaming turn emits Anthropic SSE frames in order", async () => {
    http.program("/api/chat", {
      text:
        JSON.stringify({ message: { content: "he" } }) +
        "\n" +
        JSON.stringify({ message: { content: "llo" } }) +
        "\n" +
        JSON.stringify({ done: true, done_reason: "stop", eval_count: 2 }) +
        "\n",
    });

    const res = await route(post("/v1/messages", { messages: [{ role: "user", content: "hi" }] }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  test("a request body that is not JSON is an invalid_request_error", async () => {
    const res = await route(
      new Request("http://127.0.0.1:3458/v1/messages", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  test("messages must be an array", async () => {
    const res = await route(post("/v1/messages", { model: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("messages");
  });

  test("an orphaned tool_result is refused with the id it named", async () => {
    const res = await route(
      post("/v1/messages", {
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ghost", content: "x" }] }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("toolu_ghost");
  });
});

describe("when Ollama is not there", () => {
  test("the error names the cause and is not a 200", async () => {
    // The failure this whole flow exists to undo is a session that will not
    // start with nothing on screen saying why.
    http.program("/api/chat", () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });

    const res = await route(post("/v1/messages", { messages: [{ role: "user", content: "hi" }] }));
    expect(res.ok).toBe(false);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.message).toMatch(/cannot reach Ollama|ECONNREFUSED/);
  });

  test("an upstream status is reported, not swallowed", async () => {
    http.program("/api/chat", { status: 500, text: "model runner crashed" });
    const res = await route(post("/v1/messages", { messages: [{ role: "user", content: "hi" }] }));
    expect(res.ok).toBe(false);
    expect((await res.json()).error.message).toContain("model runner crashed");
  });
});

describe("model resolution through the route", () => {
  test("a model this host never pulled is served with the configured default", async () => {
    // Claude Code picks its own small/fast model for background work. Failing
    // those calls gives a session that mostly works and reports nothing.
    http.program("/api/chat", { json: { message: { content: "ok" }, done: true } });
    await route(post("/v1/messages", { model: "claude-3-5-haiku-20241022", stream: false, messages: [] }));
    const sent = http.last("/api/chat")?.body as any;
    expect(sent.model).not.toBe("claude-3-5-haiku-20241022");
    // Compared against the configured default rather than a literal: the model
    // name is environment-dependent, and a hardcoded one asserts on whichever
    // .env happened to be beside the checkout.
    expect(sent.model).toBe(CONFIG.OLLAMA_PROXY_MODEL || CONFIG.OLLAMA_CHAT_MODEL);
  });

  test("a model it does have is used as asked", async () => {
    http.program("/api/chat", { json: { message: { content: "ok" }, done: true } });
    await route(post("/v1/messages", { model: "gemma4:e2b", stream: false, messages: [] }));
    expect((http.last("/api/chat")?.body as any).model).toBe("gemma4:e2b");
  });
});

describe("the enable gate", () => {
  test("off unless explicitly turned on", () => {
    for (const off of [undefined, "", "false", "0", "no", " "]) expect(ollamaProxyEnabled(off)).toBe(false);
    for (const on of ["1", "true", "TRUE", " yes ", "on"]) expect(ollamaProxyEnabled(on)).toBe(true);
  });

  test("the port defaults away from the one the failed router used", () => {
    expect(DEFAULT_OLLAMA_PROXY_PORT).not.toBe(3456);
    expect(ollamaProxyPort(undefined)).toBe(DEFAULT_OLLAMA_PROXY_PORT);
    expect(ollamaProxyPort("nonsense")).toBe(DEFAULT_OLLAMA_PROXY_PORT);
    expect(ollamaProxyPort("70000")).toBe(DEFAULT_OLLAMA_PROXY_PORT);
    expect(ollamaProxyPort("3999")).toBe(3999);
  });

  test("cli.ts starts the proxy only behind the gate, and never binds beyond loopback", async () => {
    const cli = await Bun.file(`${import.meta.dir}/../../cli.ts`).text();
    expect(cli).toContain("if (!ollamaProxyEnabled(process.env.OLLAMA_PROXY_ENABLED)) return;");
    const daemon = await Bun.file(`${import.meta.dir}/../../scripts/ollama-proxy.ts`).text();
    expect(daemon).toContain('const HOST = "127.0.0.1"');
    expect(daemon).toContain("hostname: HOST");
    // Never drift to another port: a providers row already names this one.
    expect(daemon).toContain("process.exit(1)");
  });
});

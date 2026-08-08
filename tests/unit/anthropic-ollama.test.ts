/**
 * The dialect gap, asserted in both directions.
 *
 * Every failure this file covers is silent in production: a dropped system
 * prompt looks like a model ignoring its rules, a truncated context looks like
 * a model forgetting, a tool call reported as `end_turn` looks like a model
 * refusing to act. None of them raises anything, so the test is where they
 * become visible.
 */

import { describe, expect, test } from "bun:test";
import {
  AnthropicStream,
  TranslationError,
  errorBody,
  estimateTokens,
  flattenSystem,
  requestText,
  resolveModel,
  serializeSse,
  stopReasonFor,
  toAnthropicResponse,
  toModelsResponse,
  toOllamaRequest,
  type AnthropicRequest,
} from "../../utils/anthropic-ollama.ts";
import { parseModelsResponse } from "../../services/provider-service.ts";

const OPTS = { model: "geekom-model-1", numCtx: 40960, stream: false };

describe("system prompt", () => {
  test("a string system prompt becomes the leading system message", () => {
    const body = toOllamaRequest({ system: "be terse", messages: [{ role: "user", content: "hi" }] }, OPTS);
    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
  });

  test("block-form system prompts are joined, not dropped", () => {
    // Claude Code sends the system prompt as blocks once it attaches cache
    // control. Taking only strings here would silently launch a session with no
    // rules and no tools description.
    const system = [
      { type: "text" as const, text: "part one" },
      { type: "text" as const, text: "part two" },
    ];
    expect(flattenSystem(system)).toBe("part one\n\npart two");
    const body = toOllamaRequest({ system, messages: [] }, OPTS);
    expect(body.messages[0].content).toBe("part one\n\npart two");
  });

  test("no system prompt adds no message", () => {
    const body = toOllamaRequest({ messages: [{ role: "user", content: "hi" }] }, OPTS);
    expect(body.messages.every((m) => m.role !== "system")).toBe(true);
  });
});

describe("context window", () => {
  test("num_ctx is always sent", () => {
    // The single most important line in the translation: Ollama does not fall
    // back to the model's own context length, so an absent num_ctx truncates
    // the prompt from the front without an error.
    const body = toOllamaRequest({ messages: [] }, OPTS);
    expect(body.options.num_ctx).toBe(40960);
  });

  test("sampling options pass through, absent ones are omitted", () => {
    const body = toOllamaRequest(
      { messages: [], max_tokens: 4096, temperature: 0.2, stop_sequences: ["END"] },
      OPTS,
    );
    expect(body.options).toMatchObject({ num_predict: 4096, temperature: 0.2, stop: ["END"] });
    expect("top_p" in body.options).toBe(false);
  });

  test("thinking is off — reasoning is not an answer", () => {
    expect(toOllamaRequest({ messages: [] }, OPTS).think).toBe(false);
  });
});

describe("tools", () => {
  const tool = {
    name: "Bash",
    description: "run a command",
    input_schema: { type: "object", properties: { cmd: { type: "string" } } },
  };

  test("input_schema becomes function.parameters", () => {
    const body = toOllamaRequest({ messages: [], tools: [tool] }, OPTS);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "Bash", description: "run a command", parameters: tool.input_schema } },
    ]);
  });

  test("tool_choice none withholds the tools entirely", () => {
    const body = toOllamaRequest({ messages: [], tools: [tool], tool_choice: { type: "none" } }, OPTS);
    expect(body.tools).toBeUndefined();
  });

  test("a tool with no schema still produces a valid object schema", () => {
    const body = toOllamaRequest({ messages: [], tools: [{ name: "Now" }] }, OPTS);
    expect(body.tools?.[0].function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("tool_use and tool_result round trip", () => {
  const conversation: AnthropicRequest = {
    messages: [
      { role: "user", content: "list the files" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running it" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.ts\nb.ts" }] },
    ],
  };

  test("the call becomes tool_calls and the result its own tool message, in order", () => {
    const body = toOllamaRequest(conversation, OPTS);
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(body.messages[1].tool_calls).toEqual([{ function: { name: "Bash", arguments: { cmd: "ls" } } }]);
    expect(body.messages[2].content).toBe("a.ts\nb.ts");
  });

  test("a result sent alongside user text still answers the call before it", () => {
    // What Claude Code sends when the operator types while a tool is running:
    // one user message whose content is [tool_result, text]. Ollama pairs a
    // result with its call by position, so emitting the text first wedged a
    // user turn between the call and its answer and moved every result after
    // it one slot out of place. Nothing raises — the model just reads the
    // wrong reply against the wrong call.
    const body = toOllamaRequest(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_5", name: "Bash", input: { cmd: "ls" } }] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_5", content: "a.ts" },
              { type: "text", text: "actually, stop" },
            ],
          },
        ],
      },
      OPTS,
    );
    expect(body.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(body.messages[1].content).toBe("a.ts");
    expect(body.messages[2].content).toBe("actually, stop");
  });

  test("block-form tool_result content is rendered, not stringified as JSON", () => {
    const body = toOllamaRequest(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Read", input: {} }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "file body" }] }],
          },
        ],
      },
      OPTS,
    );
    expect(body.messages.at(-1)?.content).toBe("file body");
  });

  test("a failed tool is marked, because Ollama has no is_error", () => {
    const body = toOllamaRequest(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_e", name: "Bash", input: {} }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_e", content: "permission denied", is_error: true }],
          },
        ],
      },
      OPTS,
    );
    // Without the marker the model reads a failure as a successful call that
    // returned that string.
    expect(body.messages.at(-1)?.content).toBe("Error: permission denied");
  });

  test("an unknown tool_use_id is refused, not dropped", () => {
    // Ollama pairs by position. A result we cannot place would otherwise vanish,
    // and the model answers as though the tool never ran — the worst outcome
    // available, because nothing reports it.
    const orphan: AnthropicRequest = {
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_missing", content: "x" }] }],
    };
    expect(() => toOllamaRequest(orphan, OPTS)).toThrow(TranslationError);
    try {
      toOllamaRequest(orphan, OPTS);
    } catch (err) {
      expect((err as TranslationError).errorType).toBe("invalid_request_error");
      expect((err as TranslationError).message).toContain("toolu_missing");
    }
  });
});

describe("unrepresentable content", () => {
  test("an image block is dropped loudly, never silently", () => {
    const dropped: string[] = [];
    toOllamaRequest(
      { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] },
      { ...OPTS, onDropped: (w) => dropped.push(w) },
    );
    expect(dropped).toEqual(["image block"]);
  });
});

describe("stop_reason", () => {
  test("a turn with tool calls is tool_use whatever Ollama says", () => {
    // Claude Code drives its agent loop off this field. `end_turn` on a turn
    // that called a tool ends the loop and reads as the model refusing to act.
    expect(stopReasonFor(true, "stop")).toBe("tool_use");
    expect(stopReasonFor(true, "length")).toBe("tool_use");
  });

  test("without tool calls it follows done_reason", () => {
    expect(stopReasonFor(false, "stop")).toBe("end_turn");
    expect(stopReasonFor(false, "length")).toBe("max_tokens");
    expect(stopReasonFor(false, undefined)).toBe("end_turn");
  });
});

describe("non-streaming response", () => {
  test("text and tool calls become Anthropic blocks with usage", () => {
    const res = toAnthropicResponse(
      {
        message: { content: "done", tool_calls: [{ function: { name: "Bash", arguments: { cmd: "ls" } } }] },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 120,
        eval_count: 8,
      },
      "geekom-model-1",
    );
    expect(res.content[0]).toEqual({ type: "text", text: "done" });
    expect(res.content[1]).toMatchObject({ type: "tool_use", name: "Bash", input: { cmd: "ls" } });
    expect(res.stop_reason).toBe("tool_use");
    expect(res.usage).toEqual({ input_tokens: 120, output_tokens: 8 });
  });

  test("an empty turn still carries one block", () => {
    const res = toAnthropicResponse({ message: { content: "" }, done: true }, "m");
    expect(res.content).toHaveLength(1);
    expect(res.content[0]).toEqual({ type: "text", text: "" });
  });
});

describe("streaming", () => {
  const names = (evts: { event: string }[]) => evts.map((e) => e.event);

  test("a text-only turn emits the Anthropic sequence in order", () => {
    const s = new AnthropicStream("m");
    const events = [
      ...s.start(10),
      ...s.chunk({ message: { content: "he" } }),
      ...s.chunk({ message: { content: "llo" } }),
      ...s.finish({ done: true, done_reason: "stop", eval_count: 2 }),
    ];
    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect((events.at(-2)?.data as any).delta.stop_reason).toBe("end_turn");
    expect((events.at(-2)?.data as any).usage.output_tokens).toBe(2);
  });

  test("the prompt size reaches message_delta, because message_start cannot carry it", () => {
    // Ollama reports prompt_eval_count only on the final chunk, so message_start
    // goes out as zero and message_delta is the one place the real number can be
    // said. Omitted, the turn's usage stays that zero — and stream is on for
    // every real turn, so a ~41k-token prompt was reported as no prompt at all
    // to anything accounting for the context window.
    const s = new AnthropicStream("m");
    const events = [
      ...s.start(),
      ...s.chunk({ message: { content: "hi" } }),
      ...s.finish({ done: true, done_reason: "stop", prompt_eval_count: 41_000, eval_count: 2 }),
    ];
    expect((events.at(-2)?.data as any).usage).toEqual({ input_tokens: 41_000, output_tokens: 2 });
  });

  test("a final chunk without counts keeps what message_start announced", () => {
    const s = new AnthropicStream("m");
    const events = [...s.start(7), ...s.finish({ done: true })];
    expect((events.at(-2)?.data as any).usage).toEqual({ input_tokens: 7, output_tokens: 0 });
  });

  test("a tool call closes the open text block first and reports tool_use", () => {
    const s = new AnthropicStream("m");
    const events = [
      ...s.start(),
      ...s.chunk({ message: { content: "calling" } }),
      ...s.chunk({ message: { tool_calls: [{ function: { name: "Bash", arguments: { cmd: "ls" } } }] } }),
      ...s.finish({ done: true, done_reason: "stop" }),
    ];
    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const toolStart = events[4].data as any;
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block).toMatchObject({ type: "tool_use", name: "Bash" });
    expect(JSON.parse((events[5].data as any).delta.partial_json)).toEqual({ cmd: "ls" });
    expect((events.at(-2)?.data as any).delta.stop_reason).toBe("tool_use");
  });

  test("a turn that produced nothing still opens and closes one block", () => {
    const s = new AnthropicStream("m");
    const events = [...s.start(), ...s.finish({ done: true })];
    expect(names(events)).toEqual(["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]);
  });

  test("events serialize as SSE frames", () => {
    expect(serializeSse({ event: "message_stop", data: { type: "message_stop" } })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });
});

describe("model resolution", () => {
  const available = ["geekom-model-1:latest", "gemma4:e2b"];

  test("an unknown model falls back rather than failing", () => {
    // Claude Code sends a small/fast model id of its own for background work,
    // and this host has never pulled it. Strict resolution would give a session
    // that mostly works, failing in places nothing reports.
    expect(resolveModel("claude-3-5-haiku-20241022", available, "geekom-model-1")).toBe("geekom-model-1");
  });

  test("an available model is used as given", () => {
    expect(resolveModel("gemma4:e2b", available, "geekom-model-1")).toBe("gemma4:e2b");
  });

  test("an untagged name matches its tagged model", () => {
    expect(resolveModel("geekom-model-1", available, "fallback")).toBe("geekom-model-1:latest");
  });

  test("no model at all is the fallback", () => {
    expect(resolveModel(undefined, available, "geekom-model-1")).toBe("geekom-model-1");
  });
});

describe("model list", () => {
  test("the body is one the real parseModelsResponse accepts", () => {
    // Asserted against the actual consumer, not a copy of its expected shape:
    // any other shape parses to null and the add-flow treats the endpoint as
    // unreachable, leaving the operator typing model names by hand.
    const body = toModelsResponse({ models: [{ model: "geekom-model-1:latest" }, { name: "gemma4:e2b" }] });
    const parsed = parseModelsResponse(body);
    expect(parsed).toEqual([
      { id: "geekom-model-1:latest", label: "geekom-model-1:latest" },
      { id: "gemma4:e2b", label: "gemma4:e2b" },
    ]);
  });

  test("an empty Ollama produces an empty list, not a crash", () => {
    expect(toModelsResponse({})).toEqual({ data: [] });
  });
});

describe("token estimate", () => {
  test("it is a positive number for any body", () => {
    const req: AnthropicRequest = {
      system: "rules",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
    };
    expect(estimateTokens(requestText(req))).toBeGreaterThan(0);
  });

  test("an empty request still counts at least one token", () => {
    expect(estimateTokens("")).toBe(1);
  });
});

describe("errors", () => {
  test("the envelope is Anthropic's, so the message reaches the terminal", () => {
    expect(JSON.parse(errorBody("api_error", "Ollama is down"))).toEqual({
      type: "error",
      error: { type: "api_error", message: "Ollama is down" },
    });
  });
});

describe("blast radius", () => {
  test("nothing in the translation layer references Claude Code's own config", async () => {
    // The failure this whole flow exists to undo: a router that configured the
    // machine instead of the process.
    const sources = await Promise.all(
      ["utils/anthropic-ollama.ts", "scripts/ollama-proxy.ts", "utils/ollama-proxy-settings.ts"].map((p) =>
        Bun.file(`${import.meta.dir}/../../${p}`).text(),
      ),
    );
    for (const src of sources) {
      const code = src
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
        .join("\n");
      expect(code).not.toContain(".claude/settings.json");
      expect(code).not.toContain("ANTHROPIC_BASE_URL");
      expect(code).not.toContain("apiKeyHelper");
    }
  });
});

/**
 * Reading a model's answer as it arrives.
 *
 * Every one of these decisions used to live inside a `while (true)` reader loop
 * in `claude/client.ts`, where the only way to reach it was to have a model
 * answer. They are hardest exactly at a chunk boundary — and a boundary is the
 * one thing a live model will not reliably reproduce.
 */

import { describe, test, expect } from "bun:test";
import {
  takeLines,
  readSseLine,
  parseOpenAiChunk,
  parseOllamaLine,
  ReasoningFilter,
  isRetryable,
  retryDelay,
  selectProvider,
  MAX_RETRIES,
  RETRY_BASE_MS,
} from "../../utils/llm-stream.ts";

describe("takeLines", () => {
  test("keeps the incomplete tail", () => {
    // A chunk almost never ends on a line boundary. Dropping the tail loses one
    // message in every few.
    expect(takeLines("a\nb\nc")).toEqual({ lines: ["a", "b"], rest: "c" });
  });

  test("a chunk ending exactly on a newline leaves nothing behind", () => {
    expect(takeLines("a\nb\n")).toEqual({ lines: ["a", "b"], rest: "" });
  });

  test("a chunk with no newline is all tail", () => {
    expect(takeLines("partial")).toEqual({ lines: [], rest: "partial" });
  });
});

describe("readSseLine", () => {
  test("a data line carries its payload", () => {
    expect(readSseLine('data: {"a":1}')).toEqual({ kind: "data", payload: '{"a":1}' });
  });

  test("[DONE] ends the stream", () => {
    expect(readSseLine("data: [DONE]")).toEqual({ kind: "done" });
  });

  test("everything else is ignored, not warned about", () => {
    // Comments, blank separators and event names all appear in real responses.
    // Treating one as a payload produces a parse warning per keep-alive.
    expect(readSseLine("")).toEqual({ kind: "ignore" });
    expect(readSseLine(": keep-alive")).toEqual({ kind: "ignore" });
    expect(readSseLine("event: message")).toEqual({ kind: "ignore" });
    expect(readSseLine("data:no-space")).toEqual({ kind: "ignore" });
  });
});

describe("parseOpenAiChunk", () => {
  test("reads the delta content", () => {
    expect(parseOpenAiChunk('{"choices":[{"delta":{"content":"hi"}}]}')).toEqual({ content: "hi" });
  });

  test("reads usage, which arrives on the last chunk rather than the first", () => {
    expect(parseOpenAiChunk('{"usage":{"prompt_tokens":12,"completion_tokens":34},"choices":[]}')).toEqual({
      inputTokens: 12,
      outputTokens: 34,
    });
  });

  test("an empty delta yields no content rather than an empty string", () => {
    // The first chunk of most streams carries only a role.
    expect(parseOpenAiChunk('{"choices":[{"delta":{"role":"assistant"}}]}')).toEqual({});
    expect(parseOpenAiChunk('{"choices":[{"delta":{"content":""}}]}')).toEqual({});
  });

  test("unparseable is null — one bad chunk costs a chunk, not the answer", () => {
    expect(parseOpenAiChunk("{oops")).toBeNull();
    expect(parseOpenAiChunk("")).toBeNull();
    expect(parseOpenAiChunk("null")).toBeNull();
  });

  test("a non-string content is not content", () => {
    expect(parseOpenAiChunk('{"choices":[{"delta":{"content":42}}]}')).toEqual({});
  });
});

describe("parseOllamaLine", () => {
  test("reads the message content", () => {
    expect(parseOllamaLine('{"message":{"content":"hi"}}')).toBe("hi");
  });

  test("blank lines and unparseable lines are nothing", () => {
    expect(parseOllamaLine("")).toBeNull();
    expect(parseOllamaLine("   ")).toBeNull();
    expect(parseOllamaLine("{oops")).toBeNull();
    expect(parseOllamaLine('{"done":true}')).toBeNull();
  });
});

describe("ReasoningFilter", () => {
  /** Feed a whole reply through, however it happens to be chopped up. */
  function run(chunks: string[]): string {
    const filter = new ReasoningFilter();
    return chunks.map((c) => filter.push(c)).join("") + filter.flush();
  }

  test("a reply with no reasoning block passes through untouched", () => {
    // The bug this replaced: skipping everything until "</think>" swallowed the
    // whole answer from any model that emits no block — including the same
    // models once the request asks them not to.
    expect(run(["The ", "answer ", "is 42."])).toBe("The answer is 42.");
  });

  test("a reasoning block is removed and the answer kept", () => {
    expect(run(["<think>weighing it up</think>", "The answer"])).toBe("The answer");
  });

  test("the opening tag split across chunks is still recognised", () => {
    // A model does not send "<think>" as one token. It sends "<", then "th",
    // then "ink>" — and a filter that decides per chunk gets three wrong
    // answers before it gets a right one.
    expect(run(["<", "th", "ink>", "hidden", "</think>", "shown"])).toBe("shown");
  });

  test("the closing tag split across chunks is still recognised", () => {
    expect(run(["<think>hidden</", "think>", "shown"])).toBe("shown");
  });

  test("text after the block in the same chunk is kept", () => {
    expect(run(["<think>hidden</think>shown"])).toBe("shown");
  });

  test("a reply shorter than the opening tag is flushed, not dropped", () => {
    // "ok" is a complete answer, and it never gets long enough to prove it is
    // not the start of "<think>".
    expect(run(["ok"])).toBe("ok");
    expect(run(["<"])).toBe("<");
    expect(run(["<th"])).toBe("<th");
  });

  test("an answer that merely starts with a tag is not mistaken for reasoning", () => {
    expect(run(["<b>bold</b>"])).toBe("<b>bold</b>");
  });

  test("an unterminated reasoning block is discarded", () => {
    // It is the model's working. Showing half of it is worse than showing none.
    expect(run(["<think>", "still thinking when the connection died"])).toBe("");
  });

  test("leading whitespace before the tag does not confuse the decision", () => {
    expect(run(["\n  <think>hidden</think>answer"])).toBe("answer");
  });

  test("once past the block nothing is inspected again", () => {
    // A later "<think>" in the answer is the answer's own text.
    const filter = new ReasoningFilter();
    filter.push("<think>a</think>");
    expect(filter.state).toBe("passthrough");
    expect(filter.push("about <think> tags")).toBe("about <think> tags");
  });

  test("flushing twice yields nothing the second time", () => {
    // "<th" is the case that reaches flush at all: it is still a possible
    // "<think>", so it is held rather than emitted. "ok" never gets there —
    // it cannot become the tag, so it goes out on the first push.
    const filter = new ReasoningFilter();
    expect(filter.push("<th")).toBe("");
    expect(filter.flush()).toBe("<th");
    expect(filter.flush()).toBe("");
  });
});

describe("isRetryable", () => {
  test("rate limits and server errors are worth another try", () => {
    expect(isRetryable(new Error("API failed: 429 Too Many Requests"))).toBe(true);
    expect(isRetryable(new Error("rate limit exceeded"))).toBe(true);
    expect(isRetryable(new Error("API failed: 503 Service Unavailable"))).toBe(true);
    expect(isRetryable(new Error("500 Internal Server Error"))).toBe(true);
  });

  test("everything else will fail again identically", () => {
    // Retrying a bad key three times only delays the error by fourteen seconds.
    expect(isRetryable(new Error("401 Unauthorized"))).toBe(false);
    expect(isRetryable(new Error("400 Bad Request"))).toBe(false);
    expect(isRetryable(new Error("model not found"))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(new Error(""))).toBe(false);
  });

  test("a status-like number that is not a status does not trigger a retry", () => {
    // Word-bounded, so a token count or an id does not read as a 5xx.
    expect(isRetryable(new Error("context length 4500 exceeded"))).toBe(false);
    expect(isRetryable(new Error("request 1500123 rejected"))).toBe(false);
  });
});

describe("retryDelay", () => {
  test("doubles each attempt", () => {
    const noJitter = () => 0;
    expect(retryDelay(0, noJitter)).toBe(RETRY_BASE_MS);
    expect(retryDelay(1, noJitter)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelay(2, noJitter)).toBe(RETRY_BASE_MS * 4);
  });

  test("adds up to a second of jitter", () => {
    // Not decoration: two sessions rate-limited by the same provider at the
    // same moment would otherwise retry in lockstep forever.
    expect(retryDelay(0, () => 1)).toBe(RETRY_BASE_MS + 1000);
    expect(retryDelay(0, () => 0.5)).toBe(RETRY_BASE_MS + 500);
  });

  test("the whole budget is bounded", () => {
    const worst = [0, 1, 2].reduce((sum, a) => sum + retryDelay(a, () => 1), 0);
    expect(MAX_RETRIES).toBe(3);
    expect(worst).toBeLessThan(20_000);
  });
});

describe("selectProvider", () => {
  test("preference order", () => {
    expect(selectProvider({ anthropic: "k", googleAi: "g", openrouter: "o" })).toBe("anthropic");
    expect(selectProvider({ googleAi: "g", openrouter: "o" })).toBe("google-ai");
    expect(selectProvider({ openrouter: "o" })).toBe("openai");
  });

  test("no keys at all still runs, locally", () => {
    // What makes the project usable before anything is configured.
    expect(selectProvider({})).toBe("ollama");
    expect(selectProvider({ anthropic: "", googleAi: "", openrouter: "" })).toBe("ollama");
  });
});

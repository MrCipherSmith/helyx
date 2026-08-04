/**
 * What the summariser is allowed to hand back, whatever the model said.
 *
 * The contract asked of the model is `{ summary, facts: string[] }`, and for a
 * long time the parsed JSON was returned as-is. A model that omitted `facts`,
 * or returned `facts: null`, therefore produced an object whose `facts` was not
 * an array — and `memory/summarizer.ts` calls `.filter` on it directly. The
 * disconnect handoff crashed, and the summary that was already generated was
 * lost with it.
 *
 * So the tests below are about the untrusted half of the boundary: not "does
 * the model behave", but "does anything the model can say still leave a caller
 * with an array to iterate".
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { normalizeSummaryResult, summarizeConversation } from "../../claude/client.ts";
import { CONFIG } from "../../config.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";

describe("normalizeSummaryResult", () => {
  test("a well-formed payload passes through unchanged", () => {
    expect(normalizeSummaryResult({ summary: "we shipped it", facts: ["a", "b"] }))
      .toEqual({ summary: "we shipped it", facts: ["a", "b"] });
  });

  // The three shapes that actually crashed the handoff.
  test.each([
    ["facts omitted", { summary: "s" }],
    ["facts null", { summary: "s", facts: null }],
    ["facts an object", { summary: "s", facts: { 0: "a" } }],
    ["facts a string", { summary: "s", facts: "a, b" }],
  ])("%s yields an empty array, not undefined", (_label, parsed) => {
    const result = normalizeSummaryResult(parsed);
    expect(Array.isArray(result.facts)).toBe(true);
    expect(result.facts).toEqual([]);
    // The assertion that matters: the call the caller makes does not throw.
    expect(() => result.facts.filter((f) => f.length > 0)).not.toThrow();
  });

  test("non-string entries are dropped rather than carried", () => {
    // Kept as strings, because the caller trims and measures them. A number
    // reaching `f.trim()` is the same class of crash one level down.
    const result = normalizeSummaryResult({ summary: "s", facts: ["keep", 42, null, { a: 1 }, "also"] });
    expect(result.facts).toEqual(["keep", "also"]);
  });

  test("a non-string summary is coerced, and a missing one becomes empty", () => {
    expect(normalizeSummaryResult({ summary: 42, facts: [] }).summary).toBe("42");
    expect(normalizeSummaryResult({ facts: [] }).summary).toBe("");
    expect(normalizeSummaryResult({ summary: null, facts: [] }).summary).toBe("");
  });

  test.each([
    ["null", null],
    ["a bare string", "not an object"],
    ["a number", 7],
    ["an array", ["a", "b"]],
  ])("valid JSON that is not the expected object (%s) still yields the shape", (_label, parsed) => {
    expect(normalizeSummaryResult(parsed)).toEqual({ summary: "", facts: [] });
  });
});

/**
 * And that `summarizeConversation` actually applies it.
 *
 * The pure function above can be correct while the call site returns the raw
 * parse — which is precisely what the regression was. This drives the real
 * function over a fake Ollama and asserts on what comes back out.
 */
describe("summarizeConversation", () => {
  let http: FakeFetch;
  let restore: () => void;
  // `as const` on CONFIG is a compile-time guarantee only; the fields are
  // ordinary and writable. Set here rather than through the environment
  // because CONFIG binds at import, long before this file runs — so a test
  // that relied on `.env` would assert on the developer's machine instead of
  // on the code.
  const mutable = CONFIG as unknown as Record<string, unknown>;
  let previousModel: unknown;

  beforeEach(() => {
    ({ http, restore } = installFakeFetch());
    previousModel = mutable.SUMMARIZE_MODEL;
    mutable.SUMMARIZE_MODEL = "test-summarizer";
  });

  afterEach(() => {
    mutable.SUMMARIZE_MODEL = previousModel;
    restore();
  });

  function serveSummary(content: string) {
    http.program("/api/chat", { json: { message: { content } } });
  }

  const messages = [{ role: "user", content: "hello" }];

  test("a payload with no facts comes back with an empty array", async () => {
    serveSummary(JSON.stringify({ summary: "they said hello" }));

    const result = await summarizeConversation(messages);

    expect(result.summary).toBe("they said hello");
    expect(result.facts).toEqual([]);
    expect(() => result.facts.filter((f) => f.trim().length >= 30)).not.toThrow();
  });

  test("facts: null comes back with an empty array", async () => {
    serveSummary(JSON.stringify({ summary: "s", facts: null }));

    expect((await summarizeConversation(messages)).facts).toEqual([]);
  });

  test("well-formed facts survive", async () => {
    serveSummary(JSON.stringify({ summary: "s", facts: ["one", "two"] }));

    expect((await summarizeConversation(messages)).facts).toEqual(["one", "two"]);
  });
});

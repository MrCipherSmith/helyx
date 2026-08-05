/**
 * The two functions that reach the world, and the four defects that lived in
 * them because nothing could.
 *
 * `reviewer-service.test.ts` covers the pure helpers and opens by saying the
 * network and the database are deliberately left out. That was a defensible
 * line to draw, and everything that went wrong was on the far side of it: a CLI
 * flag that had been removed, a model the account cannot use, an auth header
 * that ignored the provider's scheme, an output budget a reasoning model spent
 * entirely on thinking, and a prompt with no code in it. Five defects, none of
 * them subtle, none of them reachable.
 *
 * So these tests exist as much for the injection points as for the assertions.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  codexArgv,
  classifyCodexFailure,
  callCodexReview,
  buildReviewPrompt,
  cutToBytes,
  byteLength,
  REVIEW_MAX_TOKENS,
  REVIEW_MAX_TOKENS_FALLBACK,
  isBudgetRejection,
  REVIEW_TRUNCATED,
  REVIEW_DIFF_BUDGET_BYTES,
  REVIEW_REQUEST_BUDGET_BYTES,
  budgetFor,
  callProviderReview,
  type Reviewer,
  type SpawnCodex,
  type GetProvider,
} from "../../services/reviewer-service.ts";
import { providerAuthHeaders, type Provider } from "../../services/provider-service.ts";
import { installFakeFetch, blockedRequests, type FakeFetch } from "../fixtures/fake-fetch.ts";

const CODEX: Reviewer = { id: "codex", kind: "codex", model: "gpt-5.6-sol", enabled: true };

/** A spawn that answers with fixed output and records the argv it was given. */
function fakeSpawn(result: { stdout?: string; stderr?: string; exitCode?: number }) {
  const calls: string[][] = [];
  const spawn: SpawnCodex = async (argv) => {
    calls.push(argv);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
  return { spawn, calls };
}

describe("codexArgv", () => {
  test("uses the exec subcommand, not the flag the CLI removed", () => {
    const argv = codexArgv("gpt-5.6-sol", "review this");
    expect(argv).toContain("exec");
    // The literal defect: every review for as long as this was here failed on
    // the command line before Codex was asked anything.
    expect(argv).not.toContain("--no-interactive");
  });

  test("carries the model and the prompt", () => {
    const argv = codexArgv("some-model", "the prompt");
    expect(argv[argv.indexOf("-m") + 1]).toBe("some-model");
    expect(argv.at(-1)).toBe("the prompt");
  });
});

describe("classifyCodexFailure", () => {
  test("the exact usage error this flow observed is a usage error", () => {
    const stderr = "error: unexpected argument '--no-interactive' found\n\n  tip: a similar argument exists: '--no-alt-screen'";
    expect(classifyCodexFailure(2, "", stderr)).toContain("cli-usage");
  });

  test("the exact model rejection this flow observed names the model", () => {
    // As measured: exit 1, nothing on stdout, the API's refusal on stderr.
    const stderr = `ERROR: {"type":"error","status":400,"error":{"message":"The 'gpt-4.5-mini' model is not supported when using Codex with a ChatGPT account."}}`;
    expect(classifyCodexFailure(1, "", stderr)).toContain("model-unsupported");
  });

  // The whole point: neither of the two above may ever be reported as a limit
  // again. That is what was on screen while the command line was malformed.
  test.each([
    ["a usage error", 2, "", "error: unexpected argument '--no-interactive' found"],
    ["an unsupported model", 1, "", "ERROR: not supported when using Codex with a ChatGPT account"],
  ])("%s is not reported as a limit", (_label, exit, out, err) => {
    const verdict = classifyCodexFailure(exit as number, out as string, err as string)!;
    expect(verdict).not.toContain("limit");
  });

  test("a real limit and a real auth failure keep their names", () => {
    expect(classifyCodexFailure(1, "", "ERROR: rate limit exceeded")).toBe("limit");
    expect(classifyCodexFailure(1, "", "error: unauthorized")).toBe("auth");
    expect(classifyCodexFailure(1, "", "ERROR: you are not logged in")).toBe("auth");
  });

  test("a reason the CLI did not mark as an error degrades to the exit code, not to a guess", () => {
    // The cost of reading only the CLI's own error lines, stated rather than
    // discovered later: a message that arrives unprefixed loses its name. It
    // stays a failure, and it stays honest — which is the direction to err in,
    // given that the alternative is reading a diff's contents as a diagnosis.
    expect(classifyCodexFailure(1, "", "rate limit exceeded")).toBe("failed (exit 1)");
  });

  test("a crash carries its exit code instead of a guess", () => {
    expect(classifyCodexFailure(137, "", "")).toBe("failed (exit 137)");
  });

  test("a clean run with nothing to say is its own answer", () => {
    expect(classifyCodexFailure(0, "   ", "")).toBe("empty output");
  });

  test("a successful review is not a failure", () => {
    expect(classifyCodexFailure(0, "Looks fine, but line 12…", "")).toBeNull();
  });

  /**
   * The classifier reading its own prompt back.
   *
   * `codex exec` echoes the prompt on stderr under a `user` heading. The prompt
   * is a diff, and on this branch the diff contains this very file — including
   * the literal strings the classifier matches on. The first real run after the
   * `exec` fix reported `cli-usage` for a run that had actually failed on the
   * model, because the reviewer was being shown its own source code.
   */
  describe("the prompt is subtracted before anything is matched", () => {
    const poison = "review this diff: - if (/unexpected argument|unrecognized subcommand/.test(all))";

    test("a prompt containing the usage patterns does not fake a usage error", () => {
      const echoed = `OpenAI Codex v0.146.0\nuser\n${poison}\n`;
      expect(classifyCodexFailure(0, "the review body", echoed, poison)).toBeNull();
    });

    test("and a real usage error is still caught when the prompt is innocent", () => {
      expect(classifyCodexFailure(2, "", "error: unexpected argument '--no-interactive' found", "review the branch"))
        .toContain("cli-usage");
    });

    test("a real failure is not hidden by a prompt that happens to quote it", () => {
      // The prompt is removed, not the whole line: the CLI's own copy survives.
      const stderr = `user\n${poison}\nerror: unexpected argument '--nope' found`;
      expect(classifyCodexFailure(2, "", stderr, poison)).toContain("cli-usage");
    });

    test("no prompt given means nothing is subtracted", () => {
      expect(classifyCodexFailure(2, "", "error: unexpected argument found")).toContain("cli-usage");
    });

    test("a run that answered is never diagnosed, whatever it printed on the way", () => {
      // The second real run: Codex explored the repository, printed this
      // module's source on stderr, and its own patterns were read back as a
      // usage error — of a run that had succeeded.
      const noise = "exec sed -n '1,240p' services/reviewer-service.ts\nerror: unexpected argument";
      expect(classifyCodexFailure(0, "the findings", noise, "")).toBeNull();
    });

    test("a quoted error line does not diagnose a failed run either", () => {
      // File content arrives indented or diff-prefixed; the CLI's own errors
      // start the line.
      const quoted = "  const stderr = \"error: unexpected argument found\";\n+error: unexpected argument found is in the diff";
      expect(classifyCodexFailure(1, "", quoted, "")).toBe("failed (exit 1)");
    });

    test("removing the prompt cannot form a phrase across the seam", () => {
      // Raised in review: rejoining the pieces with a space would splice
      // "rate " and "limit" into a limit that was never reported.
      const p = "PROMPT";
      expect(classifyCodexFailure(0, "the review", `rate ${p}limit`, p)).toBeNull();
    });
  });
});

describe("cutToBytes", () => {
  // Raised in review, twice over: the limit is expressed in bytes, and half of
  // an emoji is not a character.
  const emoji = "🧠"; // four UTF-8 bytes, two UTF-16 code units

  test("counted in bytes, not in characters", () => {
    expect(byteLength(emoji)).toBe(4);
    expect(emoji.length).toBe(2);
    // Four of them are sixteen bytes: a character budget would have let this
    // through a check meant to stop it.
    expect(cutToBytes(emoji.repeat(4), 8)).toBe(emoji.repeat(2));
  });

  test("a cut that would land inside a character moves back", () => {
    const cut = cutToBytes(`ab${emoji}cd`, 4); // mid-emoji
    expect(cut).toBe("ab");
    expect(cut).not.toContain("�");
  });

  test("a cut on a boundary keeps the whole character", () => {
    expect(cutToBytes(`ab${emoji}cd`, 6)).toBe(`ab${emoji}`);
  });

  test("text within budget is untouched, and a zero budget is empty", () => {
    expect(cutToBytes("short", 99)).toBe("short");
    expect(cutToBytes("short", 0)).toBe("");
  });

  test("the prompt builder uses it", () => {
    const diff = `${"x".repeat(10)}${emoji}${"y".repeat(10)}`;
    const prompt = buildReviewPrompt("Review.", diff, 12); // mid-emoji
    expect(prompt).not.toContain("�");
    expect(prompt).not.toContain("\ud83e"); // the lone high surrogate
  });
});

describe("isBudgetRejection", () => {
  // Raised in review: one provider's generous budget must not turn another
  // provider's smaller model into a permanent failure.
  test("recognises the ways a provider says the ask is too big", () => {
    expect(isBudgetRejection('{"error":{"message":"max_tokens is too large"}}')).toBe(true);
    expect(isBudgetRejection("maximum context length exceeded")).toBe(true);
    expect(isBudgetRejection("output limit for this model is 8192")).toBe(true);
  });

  test("and does not claim every 400 is one", () => {
    expect(isBudgetRejection('{"error":{"message":"unknown model"}}')).toBe(false);
    expect(REVIEW_MAX_TOKENS_FALLBACK).toBeLessThan(REVIEW_MAX_TOKENS);
  });
});

describe("callCodexReview", () => {
  test("spawns exec and returns the review", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "the review body", exitCode: 0 });
    const report = await callCodexReview(CODEX, "review this", spawn);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("exec");
    expect(report.ok).toBe(true);
    expect(report.content).toBe("the review body");
  });

  test("a usage error is reported as one, not as a quota", async () => {
    const { spawn } = fakeSpawn({ stderr: "error: unexpected argument '--no-interactive' found", exitCode: 2 });
    const report = await callCodexReview(CODEX, "review this", spawn);

    expect(report.ok).toBe(false);
    expect(report.error).toContain("cli-usage");
    expect(report.error).not.toContain("limit/auth/unavailable");
  });

  test("a spawn that throws is the error it threw", async () => {
    const spawn: SpawnCodex = async () => { throw new Error("ENOENT: codex not installed"); };
    const report = await callCodexReview(CODEX, "review this", spawn);

    expect(report.ok).toBe(false);
    expect(report.error).toContain("ENOENT");
  });

  test("the prompt carries the non-interactive directive", async () => {
    // Without it, the operator's own ~/.codex/AGENTS.md turned "review this"
    // into a menu — exit 0, non-empty, and recorded as a successful review.
    const { spawn, calls } = fakeSpawn({ stdout: "the review body", exitCode: 0 });
    await callCodexReview(CODEX, "review this", spawn);

    const sent = calls[0]!.at(-1)!;
    expect(sent).toContain("running non-interactively");
    expect(sent).toContain("do not offer a choice of modes");
    expect(sent).toContain("review this");
  });

  test("ANSI from the CLI does not reach the report", async () => {
    const { spawn } = fakeSpawn({ stdout: "[32mgreen review[0m", exitCode: 0 });
    const report = await callCodexReview(CODEX, "review this", spawn);
    expect(report.content).toBe("green review");
  });
});

describe("providerAuthHeaders", () => {
  // The rule now has one definition. It had two, and the second — a hardcoded
  // Bearer in the review call — would have 401'd the first api_key provider
  // anyone registered, and been reported as an auth problem with the account.
  test("bearer", () => {
    const headers = providerAuthHeaders("tok", "bearer");
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("api_key", () => {
    const headers = providerAuthHeaders("tok", "api_key");
    expect(headers["x-api-key"]).toBe("tok");
    expect(headers.authorization).toBeUndefined();
  });

  test("anthropic-version rides along on both", () => {
    expect(providerAuthHeaders("t", "bearer")["anthropic-version"]).toBe("2023-06-01");
    expect(providerAuthHeaders("t", "api_key")["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("buildReviewPrompt", () => {
  test("the code is in the prompt", () => {
    const prompt = buildReviewPrompt("Review PR #61.", "--- a/x.ts\n+++ b/x.ts\n+const a = 1;");
    expect(prompt).toContain("Review PR #61.");
    expect(prompt).toContain("const a = 1;");
  });

  test("no diff says so instead of inviting a guess", () => {
    const prompt = buildReviewPrompt("Review the branch.", "");
    expect(prompt).toContain("No diff");
    expect(prompt).not.toContain("=== DIFF ===");
  });

  test("an empty request still asks for a review", () => {
    expect(buildReviewPrompt("   ", "+x")).toContain("Review the changes below.");
  });

  test("an oversized diff is cut, and the cut is announced", () => {
    const diff = "x".repeat(200);
    const prompt = buildReviewPrompt("Review.", diff, 100);
    expect(prompt).toContain("truncated at 100 bytes of 200");
    // Announced, because a silently shortened diff produces a confident review
    // of code the reviewer never saw.
    expect(prompt).toContain("the rest was not provided");
  });

  test("a diff inside the budget is untouched", () => {
    const prompt = buildReviewPrompt("Review.", "+one line");
    expect(prompt).not.toContain("truncated");
  });

  test("an unbounded request cannot push the argument past the limit", () => {
    // Raised in review: the diff was bounded and the request was not, so the
    // single argv element was unbounded regardless of how the diff was cut.
    const prompt = buildReviewPrompt("R".repeat(200_000), "+x");
    expect(byteLength(prompt)).toBeLessThan(REVIEW_REQUEST_BUDGET_BYTES + 1_000);
  });

  test("a provider is not narrowed by the CLI's argument limit", () => {
    // The bound exists because Codex takes the prompt as one argv element. An
    // HTTP provider has no such constraint, and was being shown less than
    // existed — including the tests for the code it was reviewing.
    expect(budgetFor({ id: "codex", kind: "codex", model: "m", enabled: true }))
      .toBe(REVIEW_DIFF_BUDGET_BYTES);
    expect(budgetFor({ id: "p:1", kind: "provider", providerId: 1, model: "m", enabled: true }))
      .toBeGreaterThan(REVIEW_DIFF_BUDGET_BYTES);
  });

  test("the whole prompt stays inside a single command-line argument", () => {
    // Raised in review: the Codex prompt is one argv entry and Linux caps that
    // at 128 KiB. Counting the budget in bytes is what makes this arithmetic
    // possible at all.
    const MAX_ARG_STRLEN = 128 * 1024;
    expect(REVIEW_DIFF_BUDGET_BYTES).toBeLessThan(MAX_ARG_STRLEN - 16_000);
  });
});

describe("callProviderReview over a faked provider", () => {
  let http: FakeFetch;
  let restore: () => void;
  const blockedAtStart = blockedRequests();

  const REVIEWER: Reviewer = { id: "provider:1", kind: "provider", providerId: 1, model: "deepseek-v4-pro", enabled: true };

  function provider(overrides: Partial<Provider> = {}): GetProvider {
    return async () => ({
      id: 1,
      name: "DeepSeek",
      base_url: "https://api.deepseek.com/anthropic",
      auth_token: "secret-token",
      auth_scheme: "bearer",
      models: [],
      created_at: new Date(),
      ...overrides,
    } as Provider);
  }

  beforeEach(() => {
    ({ http, restore } = installFakeFetch());
  });

  afterEach(() => restore());

  test("the request carries the prompt and a budget a reasoning model can finish in", async () => {
    // Asserted on the wire, not on the constant: the defect was that 4,096
    // reached the provider, and only the body proves what was sent.
    http.program("/chat/completions", { json: { choices: [{ message: { content: "a review" }, finish_reason: "stop" }] } });

    const report = await callProviderReview(REVIEWER, "the prompt with the diff in it", http.fetch, provider());

    expect(report.ok).toBe(true);
    expect(report.content).toBe("a review");

    const body = http.last("/chat/completions")!.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(REVIEW_MAX_TOKENS);
    expect(JSON.stringify(body.messages)).toContain("the prompt with the diff in it");
  });

  test("a reasoning model that spends its whole budget is reported as truncated", () => {
    // The measured shape, exactly: 200, well-formed, finish_reason "length",
    // nothing said. This used to read "empty response", which pointed at the
    // account instead of at the budget.
    http.program("/chat/completions", { json: { choices: [{ message: { content: "" }, finish_reason: "length" }] } });

    return callProviderReview(REVIEWER, "review", http.fetch, provider()).then((report) => {
      expect(report.ok).toBe(false);
      expect(report.error).toBe(REVIEW_TRUNCATED);
      expect(report.error).not.toBe("empty response");
    });
  });

  test("an empty answer that was not truncated keeps the older, honest name", async () => {
    http.program("/chat/completions", { json: { choices: [{ message: { content: "" }, finish_reason: "stop" }] } });
    const report = await callProviderReview(REVIEWER, "review", http.fetch, provider());
    expect(report.error).toBe("empty response");
  });

  test("the auth header follows the provider's scheme", async () => {
    http.program("/chat/completions", { json: { choices: [{ message: { content: "ok" } }] } });

    await callProviderReview(REVIEWER, "review", http.fetch, provider({ auth_scheme: "api_key" }));
    expect(http.last("/chat/completions")!.headers["x-api-key"]).toBe("secret-token");

    await callProviderReview(REVIEWER, "review", http.fetch, provider({ auth_scheme: "bearer" }));
    expect(http.last("/chat/completions")!.headers.authorization).toBe("Bearer secret-token");
  });

  test("the Anthropic-compat suffix is stripped for the OpenAI-protocol call", async () => {
    http.program("/chat/completions", { json: { choices: [{ message: { content: "ok" } }] } });
    await callProviderReview(REVIEWER, "review", http.fetch, provider());
    expect(http.last("/chat/completions")!.url).toBe("https://api.deepseek.com/chat/completions");
  });

  test("a limit is a limit and a plain error is not", async () => {
    http.program("/chat/completions", { status: 429, json: { error: "slow down" } });
    expect((await callProviderReview(REVIEWER, "r", http.fetch, provider())).error).toBe("limit/balance");

    http.program("/chat/completions", { status: 400, json: { error: { message: "bad model" } } });
    expect((await callProviderReview(REVIEWER, "r", http.fetch, provider())).error).toBe("http 400");
  });

  test("a body that fails to arrive is still this reviewer's error", async () => {
    // The abort signal covers the body, and this read used to sit outside the
    // try: a timeout after the headers arrived escaped the function and was
    // reported by `Promise.allSettled` under the reviewer's id, naming neither
    // the provider nor the cause.
    http.program("/chat/completions", () => {
      throw new Error("TimeoutError: The operation timed out.");
    });

    const report = await callProviderReview(REVIEWER, "r", http.fetch, provider());
    expect(report.ok).toBe(false);
    expect(report.label).toBe("DeepSeek");
    expect(report.error).toContain("network");
  });

  test("an unknown provider is named as one", async () => {
    const report = await callProviderReview(REVIEWER, "r", http.fetch, async () => null);
    expect(report.ok).toBe(false);
    expect(report.error).toBe("unknown provider");
  });

  test("none of this reached a real host", () => {
    expect(blockedRequests()).toBe(blockedAtStart);
  });

  test("the truncation constant says what happened, not that nothing did", () => {
    expect(REVIEW_TRUNCATED).toContain("budget");
    expect(REVIEW_MAX_TOKENS).toBeGreaterThan(4_096);
  });
});

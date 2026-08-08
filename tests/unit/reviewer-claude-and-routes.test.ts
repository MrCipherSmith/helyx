/**
 * Flow 056 — three reviewers out of four could not be reached, and the reasons
 * were not the reasons reported.
 *
 * Each describe below holds one of the defects still, with the shape that was
 * actually measured on 2026-08-08 rather than an invented one:
 *
 * - z.ai answers a wrong route with HTTP 200 and an error in the body, so a
 *   misrouted reviewer was reported as a model with nothing to say.
 * - the OpenAI route was derived by chopping a suffix off the Anthropic URL,
 *   which is right for exactly one of the four registered vendors.
 * - a nested `claude` inherits `CHANNEL_SOURCE` from the session that spawned
 *   it, registers as a remote session for the same project, and takes the
 *   channel lease from its own parent. That one is not a report being wrong;
 *   it is a review killing the session that asked for it.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  claudeArgv,
  claudeEnv,
  classifyClaudeFailure,
  callClaudeReview,
  openAiRouteFor,
  providerErrorInBody,
  callProviderReview,
  budgetFor,
  CLAUDE_STRIPPED_ENV,
  CLAUDE_DEFAULT_MODEL,
  REVIEW_DIFF_BUDGET_BYTES,
  REVIEW_DIFF_BUDGET_BYTES_PROVIDER,
  type Reviewer,
  type SpawnClaude,
  type GetProvider,
} from "../../services/reviewer-service.ts";
import { renderReviewer } from "../../bot/commands/reviewers.ts";
import type { Provider } from "../../services/provider-service.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";

const CLAUDE: Reviewer = { id: "claude", kind: "claude", model: "claude-opus-5", enabled: true };

/** A spawn that answers with fixed output and records argv and environment. */
function fakeSpawn(result: { stdout?: string; stderr?: string; exitCode?: number }) {
  const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnClaude = async (argv, env) => {
    calls.push({ argv, env });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
  return { spawn, calls };
}

describe("claudeArgv", () => {
  test("does not load the global MCP servers", () => {
    // `~/.claude.json` registers helyx and helyx-channel globally, for every
    // claude in every directory. A reviewer that loaded them would connect to
    // the bot on each review.
    const argv = claudeArgv("claude-opus-5", "review this");
    expect(argv).toContain("--strict-mcp-config");
    const config = argv[argv.indexOf("--mcp-config") + 1];
    // Inline JSON, not `/dev/null`: the CLI rejects an empty file with
    // "MCP config is not a valid JSON" and never gets to the review.
    expect(JSON.parse(config)).toEqual({ mcpServers: {} });
  });

  test("is non-interactive, carries the model, and ends with the prompt", () => {
    const argv = claudeArgv("some-model", "the prompt");
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("--model") + 1]).toBe("some-model");
    expect(argv.at(-1)).toBe("the prompt");
  });

  test("a reviewer is not given permission to change anything", () => {
    expect(claudeArgv("m", "p")[claudeArgv("m", "p").indexOf("--permission-mode") + 1]).toBe("plan");
  });
});

describe("claudeEnv", () => {
  test("clears CHANNEL_SOURCE — the variable that cost a session", () => {
    // run-cli.sh:137 starts a session as `CHANNEL_SOURCE=remote claude …`, so
    // it is in the session's environment and every child inherits it. With it
    // set, channel/index.ts registers the nested process as a remote session
    // for the same project and it takes the parent's lease.
    const env = claudeEnv({ CHANNEL_SOURCE: "remote", PATH: "/usr/bin" });
    expect(env.CHANNEL_SOURCE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("clears every ANTHROPIC_* binding, including the API key", () => {
    // Measured: with ANTHROPIC_API_KEY left in place the CLI answers
    // "Not logged in · Please run /login" — clearing three of the four is the
    // same as clearing none.
    const env = claudeEnv({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "glm-token",
      ANTHROPIC_API_KEY: "sk-whatever",
      ANTHROPIC_MODEL: "glm-5.2",
      HOME: "/home/altsay",
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.HOME).toBe("/home/altsay");
  });

  test("does not mutate the environment it was given", () => {
    const base = { CHANNEL_SOURCE: "remote" };
    claudeEnv(base);
    expect(base.CHANNEL_SOURCE).toBe("remote");
  });
});

describe("classifyClaudeFailure", () => {
  test("the exact refusal observed with an inherited API key is an auth failure", () => {
    // And it arrives on stdout with exit 0. Classified after the "it answered"
    // short-circuit, this line would have been recorded as the reviewer's
    // opinion of the diff.
    expect(classifyClaudeFailure(0, "Not logged in · Please run /login", "") ?? "").toContain("auth");
  });

  test("a review that discusses logins is not mistaken for a refusal", () => {
    const review = `The handler swallows the failure and logs "not logged in", so a rejected
      token is indistinguishable from an expired one. ${"Cite the code. ".repeat(20)}`;
    expect(classifyClaudeFailure(0, review, "")).toBeNull();
  });

  test("a usage limit carries the time it lifts", () => {
    const out = classifyClaudeFailure(1, "", "usage limit reached. try again at Aug 11th, 2026 5:49 PM.") ?? "";
    expect(out).toContain("limit until");
    expect(out).toContain("aug 11th");
  });

  test("a review that happens to discuss rate limits is still a review", () => {
    // The same short-circuit the Codex classifier needs, for the same reason:
    // the prompt is a diff, and a diff of this repository is full of the words
    // the classifier looks for.
    expect(classifyClaudeFailure(0, "The retry loop ignores the rate limit header.", "")).toBeNull();
  });

  test("exit 0 with nothing said is not silently a success", () => {
    expect(classifyClaudeFailure(0, "", "")).toBe("empty output");
  });
});

describe("callClaudeReview", () => {
  test("the review runs with the stripped environment, not the session's", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "a review" });
    const before = process.env.CHANNEL_SOURCE;
    process.env.CHANNEL_SOURCE = "remote";
    try {
      const report = await callClaudeReview(CLAUDE, "the diff", spawn);
      expect(report.ok).toBe(true);
      expect(report.content).toBe("a review");
      expect(report.label).toBe("Claude");
      for (const key of CLAUDE_STRIPPED_ENV) expect(calls[0].env[key]).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.CHANNEL_SOURCE;
      else process.env.CHANNEL_SOURCE = before;
    }
  });

  test("the prompt reaches the CLI, behind the directive", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "a review" });
    await callClaudeReview(CLAUDE, "the diff with the bug in it", spawn);
    expect(calls[0].argv.at(-1)).toContain("the diff with the bug in it");
    // CLAUDE.md tells any agent asked for a review to run scripts/review.ts —
    // which is what called this. Without the directive the reviewer convenes
    // the reviewers.
    expect(calls[0].argv.at(-1)).toContain("Do not delegate to other reviewers");
  });

  test("a failure is a report, not a throw", async () => {
    const { spawn } = fakeSpawn({ stdout: "Not logged in · Please run /login", exitCode: 1 });
    const report = await callClaudeReview(CLAUDE, "the diff", spawn);
    expect(report.ok).toBe(false);
    expect(report.error).toContain("auth");
  });

  test("falls back to a model rather than spawning with an empty one", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "ok" });
    await callClaudeReview({ ...CLAUDE, model: "" }, "d", spawn);
    expect(calls[0].argv[calls[0].argv.indexOf("--model") + 1]).toBe(CLAUDE_DEFAULT_MODEL);
  });
});

describe("openAiRouteFor", () => {
  test("the three vendors the suffix-stripping got wrong", () => {
    // Each of these was a live reviewer failure, not a hypothetical.
    expect(openAiRouteFor("https://openrouter.ai/api")).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      known: true,
    });
    expect(openAiRouteFor("https://api.z.ai/api/anthropic")).toEqual({
      url: "https://api.z.ai/api/paas/v4/chat/completions",
      known: true,
    });
    expect(openAiRouteFor("https://api.moonshot.ai/anthropic")).toEqual({
      url: "https://api.moonshot.ai/v1/chat/completions",
      known: true,
    });
  });

  test("the one vendor it got right keeps working", () => {
    // DeepSeek is why the heuristic looked like a rule for as long as it did.
    expect(openAiRouteFor("https://api.deepseek.com/anthropic").url).toBe(
      "https://api.deepseek.com/chat/completions",
    );
  });

  test("an unknown vendor still gets called, and is flagged as a guess", () => {
    const route = openAiRouteFor("https://api.example.com/anthropic");
    expect(route.url).toBe("https://api.example.com/chat/completions");
    expect(route.known).toBe(false);
  });
});

describe("providerErrorInBody", () => {
  test("the z.ai envelope: HTTP 200 announcing a 404", () => {
    // Captured verbatim. This is the whole of the "empty response" mystery.
    const body = JSON.stringify({ code: 500, msg: "404 NOT_FOUND", success: false });
    expect(providerErrorInBody(body)).toBe("404 NOT_FOUND");
  });

  test("the OpenAI envelope, object and string forms", () => {
    expect(providerErrorInBody(JSON.stringify({ error: { message: "no credit" } }))).toBe("no credit");
    expect(providerErrorInBody(JSON.stringify({ error: "no credit" }))).toBe("no credit");
  });

  test("an ordinary completion announces nothing", () => {
    const ok = JSON.stringify({ choices: [{ message: { content: "a review" }, finish_reason: "stop" }] });
    expect(providerErrorInBody(ok)).toBeNull();
  });

  test("a success envelope is not read as a failure", () => {
    // `code: 200, success: true` must not trip the `code >= 400` branch.
    expect(providerErrorInBody(JSON.stringify({ code: 200, success: true, msg: "ok" }))).toBeNull();
  });

  test("a body that is not JSON is not an error message", () => {
    expect(providerErrorInBody("<html>502 Bad Gateway</html>")).toBeNull();
  });
});

describe("callProviderReview against the routes as they really are", () => {
  let http: FakeFetch;
  let restore: () => void;

  const GLM: Reviewer = { id: "provider:1", kind: "provider", providerId: 1, model: "glm-5.2", enabled: true };

  function provider(overrides: Partial<Provider> = {}): GetProvider {
    return async () =>
      ({
        id: 1,
        name: "GLM (Z.ai)",
        base_url: "https://api.z.ai/api/anthropic",
        auth_token: "secret-token",
        auth_scheme: "bearer",
        models: [],
        created_at: new Date(),
        ...overrides,
      }) as Provider;
  }

  beforeEach(() => {
    ({ http, restore } = installFakeFetch());
  });

  afterEach(() => restore());

  test("GLM is called on the route it actually serves", async () => {
    http.program("/api/paas/v4/chat/completions", {
      json: { choices: [{ message: { content: "a review" }, finish_reason: "stop" }] },
    });
    const report = await callProviderReview(GLM, "review", http.fetch, provider());
    expect(report.ok).toBe(true);
    expect(http.last("/api/paas/v4/chat/completions")!.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });

  test("a 200 announcing 404 is reported as the 404, not as an empty response", async () => {
    // The defect, end to end: the operator was told the model said nothing.
    http.program(/chat\/completions/, { json: { code: 500, msg: "404 NOT_FOUND", success: false } });
    const report = await callProviderReview(GLM, "review", http.fetch, provider());
    expect(report.ok).toBe(false);
    expect(report.error).toContain("404 NOT_FOUND");
    expect(report.error).not.toContain("empty response");
  });

  test("a 200 announcing no balance is still a balance problem", async () => {
    http.program(/chat\/completions/, { json: { error: { message: "Insufficient balance" } } });
    const report = await callProviderReview(GLM, "review", http.fetch, provider());
    expect(report.error).toBe("limit/balance");
  });

  test("a failure from an unmapped vendor names the vendor", async () => {
    http.program(/chat\/completions/, { status: 404, text: "not found" });
    const report = await callProviderReview(
      GLM,
      "review",
      http.fetch,
      provider({ base_url: "https://api.example.com/anthropic" }),
    );
    expect(report.error).toContain("http 404");
    expect(report.error).toContain("api.example.com");
  });
});

describe("budgetFor", () => {
  test("a CLI reviewer is bound by argv, whichever CLI it is", () => {
    // 100 KB is about MAX_ARG_STRLEN, not about the model, so it binds claude
    // for exactly the reason it binds codex.
    expect(budgetFor(CLAUDE)).toBe(REVIEW_DIFF_BUDGET_BYTES);
    expect(budgetFor({ id: "codex", kind: "codex", model: "m", enabled: true })).toBe(REVIEW_DIFF_BUDGET_BYTES);
    expect(budgetFor({ id: "provider:1", kind: "provider", providerId: 1, model: "m", enabled: true })).toBe(
      REVIEW_DIFF_BUDGET_BYTES_PROVIDER,
    );
  });
});

describe("renderReviewer", () => {
  test("a CLI reviewer is not described as provider #undefined", () => {
    expect(renderReviewer(CLAUDE)).toContain("(claude)");
    expect(renderReviewer(CLAUDE)).not.toContain("undefined");
  });

  test("a provider reviewer still names its provider row", () => {
    const line = renderReviewer({ id: "provider:6", kind: "provider", providerId: 6, model: "m", enabled: true });
    expect(line).toContain("provider #6");
  });
});

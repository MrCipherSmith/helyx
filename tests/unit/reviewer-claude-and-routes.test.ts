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

  test("every route to a shell, a file, the network or a subagent is denied", () => {
    // A deny-list, because --allowed-tools does not restrict: a CLI started
    // with `--allowed-tools Read Grep Glob` reports Bash, Write, Task, Workflow
    // and Skill all still available. And denying only the write tools is not
    // enough — with those three denied the reviewer reported it could still
    // reach a shell through Monitor and a subagent through TaskCreate.
    const argv = claudeArgv("m", "p");
    expect(argv).toContain("--disallowed-tools");
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "Task", "Agent", "Workflow", "Skill", "Monitor"]) {
      expect(argv).toContain(tool);
    }
  });

  test("plan mode is not used — it would replace the review with a plan", () => {
    // Measured through this very code path: plan mode injects Claude Code's
    // plan workflow (write a plan file, launch Explore agents, end with
    // ExitPlanMode) and contradicts every clause of CLAUDE_DIRECTIVE. The
    // answer would be a plan-approval request filed as a successful review.
    expect(claudeArgv("m", "p")).not.toContain("plan");
  });

  test("the variadic tool list does not swallow the prompt", () => {
    // The CLI takes --disallowed-tools variadically: given last, it reads the
    // prompt's words as tool names and then refuses to run for want of a
    // prompt. So it comes before the flags that take one value each.
    const argv = claudeArgv("m", "the prompt");
    expect(argv.at(-1)).toBe("the prompt");
    expect(argv.indexOf("--disallowed-tools")).toBeLessThan(argv.indexOf("--model"));
  });

  test("no --settings, because it would not do what it looks like it does", () => {
    // `--settings` loads *additional* settings; it does not replace the user's
    // file, and there is no --strict-settings to match --strict-mcp-config. It
    // was here with a comment claiming the operator's hooks were dropped, which
    // is a false claim documented as a fix — worse than the gap it described.
    const argv = claudeArgv("m", "p");
    expect(argv).not.toContain("--settings");
  });

  test("the prompt never sits directly behind a variadic flag", () => {
    // Measured twice: once as `Permission deny rule "single" matches no known
    // tool`, once as the CLI trying to open the prompt as an MCP config file.
    const argv = claudeArgv("m", "the prompt");
    const beforePrompt = argv[argv.length - 2];
    expect(beforePrompt).toBe("m");
    expect(argv[argv.length - 3]).toBe("--model");
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

  test("clears the pointers that could re-set what was just cleared", () => {
    // A settings file can carry env.ANTHROPIC_BASE_URL of its own — this is how
    // claude-code-router hijacked every session on this machine once. Stripping
    // the variables and leaving the pointer routes the "independent" review
    // back through the third-party provider, still labelled Claude.
    const env = claudeEnv({ CLAUDE_CONFIG_DIR: "/somewhere", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1" });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
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

  test("a short review that merely mentions an api key is not eaten", () => {
    // 38 characters, and under the unanchored guard it was discarded as an auth
    // failure and never reached the operator. The diff under review contains
    // the CLI's refusal text four times; reviewers quote what they cite.
    expect(classifyClaudeFailure(0, "The invalid api key path is unhandled.", "")).toBeNull();
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

  test("a host that names an Object.prototype member is not a known route", () => {
    // A plain object indexed by a host read from a database row answers
    // `constructor` with something truthy and non-string, producing a garbage
    // URL flagged `known: true` — the one case where the "this was a guess"
    // flag would be actively lying.
    for (const host of ["constructor", "__proto__", "toString", "valueOf"]) {
      const route = openAiRouteFor(`https://${host}/anthropic`);
      expect(route.known).toBe(false);
      expect(route.url).toBe(`https://${host}/chat/completions`);
    }
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

  test("a null error field announces nothing", () => {
    // Correct today by falsiness alone, which is the sort of thing that stops
    // being true when someone adds an `"error" in obj` check.
    expect(providerErrorInBody(JSON.stringify({ error: null, choices: [] }))).toBeNull();
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

  test("a spent quota is recognised from the envelope, not only from its prose", async () => {
    // The machine-readable half lives in siblings of `message`. Classifying the
    // extracted sentence alone reported this as a generic error, which then
    // failed `failureHidesFromProbe` too and left the reviewer marked green.
    http.program(/chat\/completions/, {
      json: {
        error: {
          type: "insufficient_quota",
          code: "billing_hard_limit_reached",
          message: "You exceeded your current plan.",
        },
      },
    });
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

describe("callProviderReview reading order", () => {
  let http: FakeFetch;
  let restore: () => void;

  const R: Reviewer = { id: "provider:1", kind: "provider", providerId: 1, model: "m", enabled: true };
  const prov: GetProvider = async () =>
    ({
      id: 1,
      name: "DeepSeek",
      base_url: "https://api.deepseek.com/anthropic",
      auth_token: "t",
      auth_scheme: "bearer",
      models: [],
      created_at: new Date(),
    }) as Provider;

  beforeEach(() => {
    ({ http, restore } = installFakeFetch());
  });
  afterEach(() => restore());

  test("a review is not thrown away by an empty error field beside it", async () => {
    // `providerErrorInBody` stringifies `{}` to "{}", which is truthy. Checked
    // before the content, that discarded a real review and reported the failure
    // as two braces.
    http.program(/chat\/completions/, {
      json: { error: {}, choices: [{ message: { content: "a review" }, finish_reason: "stop" }] },
    });
    const report = await callProviderReview(R, "review", http.fetch, prov);
    expect(report.ok).toBe(true);
    expect(report.content).toBe("a review");
  });

  test("a proven-good route is not blamed for a billing failure", async () => {
    // 429 from the billing layer means the request reached the vendor, so the
    // route was right. Annotating it with the URL points at the one thing the
    // response proves correct.
    http.program(/chat\/completions/, { status: 429, text: "insufficient balance" });
    const report = await callProviderReview(
      R,
      "review",
      http.fetch,
      async () => ({ ...(await prov(0))!, base_url: "https://api.example.com/anthropic" }) as Provider,
    );
    expect(report.error).toBe("limit/balance");
    expect(report.error).not.toContain("unmapped vendor");
  });
});

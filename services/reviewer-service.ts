/**
 * Reviewer orchestration — run independent code reviewers in parallel.
 *
 * A reviewer is either the Codex CLI (the pre-existing path) or a provider
 * model (e.g. DeepSeek v4-pro via the providers table). All enabled reviewers
 * are invoked concurrently on the same prompt; the caller receives every
 * report that succeeded. When *all* reviewers fail — Codex on a rate limit,
 * a provider out of balance — the result is `mode: "self"`, which CLAUDE.md
 * turns into Claude reviewing the change itself.
 *
 * Config lives in `bot_config` (key `reviewers`) as a JSON array of `Reviewer`,
 * managed by the `/reviewers` command. Nothing here is reached from the tmux
 * pane, so it follows the same "take sql and the world as arguments" rule as
 * `ask-question.ts`: the network and the database can be faked in a test.
 */

import { sql } from "../memory/db.ts";
import { lastOutcomeByReviewer, type ReviewerOutcome } from "./review-artifacts.ts";
import { providerService, providerAuthHeaders, type Provider } from "./provider-service.ts";
import { stripAnsi } from "../utils/terminal.ts";

export type ReviewerKind = "codex" | "provider" | "claude";

export interface Reviewer {
  /** Stable id used by `/reviewers remove <id>`. "codex", "claude" or "provider:<n>". */
  id: string;
  kind: ReviewerKind;
  /** `providers.id` — only meaningful for kind === "provider". */
  providerId?: number | null;
  /** The CLI model name, or the provider's model id. */
  model: string;
  enabled: boolean;
}

export interface ReviewerReport {
  reviewerId: string;
  label: string;
  model: string;
  ok: boolean;
  content?: string;
  error?: string;
}

export interface ReviewRunResult {
  /** "external" — at least one reviewer reported; "self" — all failed. */
  mode: "external" | "self";
  reports: ReviewerReport[];
}

export interface ReviewerStatus {
  id: string;
  label: string;
  model: string;
  available: boolean;
  /**
   * Whether anything actually tested this reviewer.
   *
   * A third state, and the honest one. Backends without a balance endpoint used
   * to be reported available on the strength of having no probe, which is a
   * green tick meaning "nobody asked".
   */
  probed: boolean;
  detail: string;
}

const REVIEWERS_KEY = "reviewers";

/**
 * How long a reviewer may take.
 *
 * Two minutes was enough for a model that answered from a sentence. It is not
 * enough for one that reads a diff and reasons over it inside a 32,000-token
 * budget: the first real run after this flow's other fixes timed out here, with
 * the model still thinking. Ten minutes is chosen against what the work now is,
 * not against what it used to be.
 */
const REVIEW_TIMEOUT_MS = 600_000;

/**
 * Room for a reasoning model to finish thinking *and* answer.
 *
 * This was 4,096, and on `deepseek-v4-pro` the whole of it went to reasoning:
 * measured against the real endpoint with a real diff, `completion_tokens` and
 * `reasoning_tokens` were both exactly 4,096, `finish_reason` was `length`, and
 * the content was the empty string. The reviewer was not failing — it never got
 * to the part where it speaks.
 *
 * Eight times the wall that was measured. A guess about a ceiling, which is why
 * `REVIEW_TRUNCATED` below exists rather than being assumed unnecessary.
 */
export const REVIEW_MAX_TOKENS = 32_000;

/**
 * What a smaller model can be asked for when the generous budget is refused.
 *
 * Raised in review: `REVIEW_MAX_TOKENS` is sized for the reasoning model that
 * needed it, and every configured provider now gets the same number. One with a
 * smaller output limit answers 400, and a reviewer that used to work becomes a
 * permanent failure. So a 400 is retried once at the old figure before the
 * request is given up on.
 */
export const REVIEW_MAX_TOKENS_FALLBACK = 4_096;

/** The model the Claude CLI reviewer runs on when none is configured. */
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5";

/** An error body that reads like the model rejecting the size of the ask. */
export function isBudgetRejection(body: string): boolean {
  return /max_tokens|max tokens|maximum context|context length|too large|output limit/i.test(body);
}

/** The provider answered, and spent the whole budget before saying anything. */
export const REVIEW_TRUNCATED = "truncated: the model used its whole output budget before answering";

/**
 * How much diff a review prompt carries.
 *
 * 66 KB was measured to be accepted by the provider. The binding constraint is
 * the other reviewer: the Codex prompt is passed as a single command-line
 * argument, and Linux caps one argument at 128 KiB (`MAX_ARG_STRLEN`). Raised
 * in review — the previous 120,000 was counted in UTF-16 characters, and a diff
 * with enough non-ASCII in it exceeds 128 KiB of UTF-8 well before that,
 * failing the spawn with `E2BIG`.
 *
 * So the budget is counted in bytes, which is what the limit is actually
 * expressed in, and set well below it so the directive and the request fit
 * alongside.
 */
export const REVIEW_DIFF_BUDGET_BYTES = 100_000;

/**
 * What a provider gets, which is more.
 *
 * Raised in review: the 100 KB bound exists because Codex receives the prompt
 * as one argv element. An HTTP provider has no such constraint, and on the very
 * branch under review it was being shown 26 KB less than existed — including
 * the tests written for the code it was asked about. One reviewer's transport
 * should not narrow another's evidence.
 */
export const REVIEW_DIFF_BUDGET_BYTES_PROVIDER = 400_000;

/**
 * How much of the operator's own request travels with it.
 *
 * Raised in review: the diff is bounded and the request was not, so a long
 * enough request pushes the single argv element past the limit regardless of
 * how carefully the diff was cut.
 */
export const REVIEW_REQUEST_BUDGET_BYTES = 4_096;

/**
 * The review prompt given to the model. Kept model-agnostic: the reviewer is
 * supposed to look at a diff/code and say what is wrong, not to follow the
 * repository's house style.
 */
export const REVIEW_SYSTEM_PROMPT =
  "You are an independent code reviewer. Review the provided diff and report concrete issues: " +
  "correctness bugs, logic errors, security problems, missed edge cases, and anything that looks wrong. " +
  "Cite the code. Be honest and concise.";

/** The providers registered by the operator, looked up by name for the default set. */
export async function defaultReviewers(): Promise<Reviewer[]> {
  const deepseek = await providerService.getByName("DeepSeek");
  return [
    { id: "codex", kind: "codex", model: process.env.CODEX_MODEL ?? "gpt-5.6-sol", enabled: true },
    // Unconditional, unlike the provider reviewers: it needs no row in
    // `providers` and no key, only the CLI the operator already runs. It is
    // here rather than left to `/reviewers_add` because `/reviewers_default` is
    // what an operator reaches for when the set is broken, and a default that
    // restores only the two reviewers that were down is not a repair.
    { id: "claude", kind: "claude" as const, model: CLAUDE_DEFAULT_MODEL, enabled: true },
    ...(deepseek
      ? [{ id: `provider:${deepseek.id}`, kind: "provider" as const, providerId: deepseek.id, model: "deepseek-v4-pro", enabled: true }]
      : []),
  ];
}

export async function getReviewers(): Promise<Reviewer[]> {
  const rows = await sql`SELECT value FROM bot_config WHERE key = ${REVIEWERS_KEY}`;
  const raw = (rows as unknown as { value: string }[])[0]?.value;
  if (!raw) return defaultReviewers();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Reviewer[]) : defaultReviewers();
  } catch {
    // A corrupt cache is a config problem, not a crash — resetting fixes it.
    return defaultReviewers();
  }
}

export async function setReviewers(reviewers: Reviewer[]): Promise<void> {
  await sql`
    INSERT INTO bot_config (key, value) VALUES (${REVIEWERS_KEY}, ${JSON.stringify(reviewers)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

/**
 * The bare-root base URL for an OpenAI-compatible `/chat/completions` call.
 *
 * Providers are stored with an Anthropic-compat suffix (`…/anthropic`), the
 * same shape `fetchProviderModels` has to strip — the review call speaks the
 * OpenAI protocol, which lives at the bare root.
 */
export function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/anthropic$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
}

/**
 * Where each vendor actually keeps its OpenAI-compatible chat endpoint.
 *
 * `normalizeProviderBaseUrl` above is a guess: chop the Anthropic suffix, append
 * `/chat/completions`, hope. Measured against the four providers registered on
 * this machine it is right about exactly one of them — DeepSeek — which is why
 * it looked like a rule for as long as DeepSeek was the only reviewer that ran.
 *
 *   deepseek  api.deepseek.com/anthropic  → /chat/completions          ✔ (no /v1 needed)
 *   openrouter openrouter.ai/api          → /api/chat/completions      ✘ 404
 *   z.ai      api.z.ai/api/anthropic      → /api/chat/completions      ✘ see below
 *   moonshot  api.moonshot.ai/anthropic   → /chat/completions          ✘ needs /v1
 *
 * z.ai is the one that hurt: it answers that wrong route with **HTTP 200** and
 * `{"code":500,"msg":"404 NOT_FOUND","success":false}` in the body, so the
 * request "succeeded", the content was empty, and the operator was told the
 * model had nothing to say. See `providerErrorInBody`.
 *
 * Keyed by host so a stored URL that differs in path or trailing slash still
 * matches, and falling back to the old behaviour for a vendor nobody has taught
 * this map about — a guess is still better than refusing to call.
 *
 * A `Map`, not an object literal: indexed by a host read out of a database row,
 * a plain object answers `constructor` and `__proto__` with something truthy
 * and non-string, producing a garbage URL flagged `known: true` — the one case
 * where the "this was a guess" flag would be actively lying.
 */
const OPENAI_ROUTE_BY_HOST = new Map<string, string>([
  ["openrouter.ai", "/api/v1/chat/completions"],
  ["api.z.ai", "/api/paas/v4/chat/completions"],
  ["api.moonshot.ai", "/v1/chat/completions"],
  ["api.moonshot.cn", "/v1/chat/completions"],
  ["api.deepseek.com", "/chat/completions"],
]);

/**
 * The full URL to POST a review to, and whether it came from the map.
 *
 * The flag is not decoration: when the fallback answered, the vendor is named in
 * the failure so the next person reads "openrouter.ai: http 404" rather than a
 * bare 404 that could have come from anywhere.
 */
export function openAiRouteFor(baseUrl: string): { url: string; known: boolean } {
  let host = "";
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // Not a URL at all. The fallback below produces the same string the
    // previous code did, so a malformed row fails the way it used to.
  }
  const mapped = OPENAI_ROUTE_BY_HOST.get(host);
  if (mapped) {
    const origin = new URL(baseUrl).origin;
    return { url: `${origin}${mapped}`, known: true };
  }
  return { url: `${normalizeProviderBaseUrl(baseUrl)}/chat/completions`, known: false };
}

/**
 * The error a 200 is carrying, if it is carrying one.
 *
 * A success status is not a success. z.ai reports a missing route as
 * `{"code":500,"msg":"404 NOT_FOUND","success":false}` under HTTP 200; several
 * OpenAI-compatible gateways do the same with `{"error":{"message":…}}`. Every
 * one of those used to reach the `!content` branch and be reported as "empty
 * response" — a wrong route described as a quiet model, which sends whoever
 * reads it to the account page instead of the URL.
 *
 * Returns null when the body says nothing about a failure, which includes every
 * ordinary successful completion.
 */
export function providerErrorInBody(body: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // `{"error": {...}}` or `{"error": "…"}` — the OpenAI shape.
  const err = obj.error;
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 200);
  if (err && typeof err === "object") {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 200);
    return JSON.stringify(err).slice(0, 200);
  }

  // `{"code":500,"msg":"404 NOT_FOUND","success":false}` — the z.ai shape.
  // `success: false` is the reliable half; `code` is 200-as-a-number on some
  // gateways and a string on others, so it is only read when it disagrees.
  const failed =
    obj.success === false ||
    (typeof obj.code === "number" && obj.code >= 400) ||
    (typeof obj.code === "string" && /^\d+$/.test(obj.code) && Number(obj.code) >= 400);
  if (failed) {
    const msg = obj.msg ?? obj.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 200);
    return `provider error ${String(obj.code ?? "")}`.trim().slice(0, 200);
  }

  return null;
}

/** Whether an OpenAI-compatible error response means "this reviewer is down". */
export function isProviderLimitError(status: number, body: string): boolean {
  return status === 429 || /insufficient|balance|quota|rate limit|billing/i.test(body);
}

/** Mode decision: at least one report succeeded ⇒ external, otherwise self. */
export function pickMode(reports: ReviewerReport[]): "external" | "self" {
  return reports.some((r) => r.ok) ? "external" : "self";
}

/**
 * The argv for a non-interactive Codex run.
 *
 * `exec` is a subcommand, not a flag. This was `--no-interactive`, which the
 * CLI stopped accepting:
 *
 *   error: unexpected argument '--no-interactive' found
 *
 * Every review since then failed on the command line, before Codex was ever
 * asked anything. Extracted so a test can read the argv without a CLI on the
 * machine — the shape of this call is precisely what went wrong.
 */
export function codexArgv(model: string, prompt: string): string[] {
  return ["npx", "@openai/codex", "exec", "-m", model, prompt];
}

/**
 * Said to Codex, and only to Codex.
 *
 * The provider reviewers get `REVIEW_SYSTEM_PROMPT` as a system message; the
 * CLI has no such channel, and it reads the operator's own `~/.codex/AGENTS.md`
 * and skills. With those loaded, "review this" routed to a chooser: the first
 * run that got past the argv bug answered
 *
 *   Choose review mode:
 *   1. Direct review — quick, no persistent docs.
 *   2. Job Orchestrator — persistent `jobs/` documentation and traceability.
 *
 * — exit 0, non-empty, and therefore recorded as a successful review. A
 * question is not a review. Verified against the real CLI: with this preamble
 * the same prompt comes back as findings.
 *
 * Written as instructions to the model rather than imposed by changing the
 * operator's global Codex configuration, which is theirs and is used for other
 * things.
 */
export const CODEX_DIRECTIVE =
  "You are running non-interactively. Output the review itself as your final message. " +
  "Do not ask questions, do not offer a choice of modes, do not route to another skill or " +
  "orchestrator, and do not create or write any files.";

/**
 * Why a Codex run produced nothing.
 *
 * Everything used to collapse into `"limit/auth/unavailable"` — one string for
 * a spent quota, a rejected login, a crash, and a command line the CLI could
 * not parse. So the operator was told, for as long as the flag had been wrong,
 * that they were out of quota. The report was not merely unhelpful; it pointed
 * away from the defect.
 *
 * Null means the run succeeded and `out` is the review.
 */
export function classifyCodexFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
  prompt = "",
): string | null {
  const out = stdout.trim();

  // It answered. Nothing to diagnose, and nothing in the noise it printed on
  // the way can change that.
  //
  // This short-circuit is the first of two defences, and it is the load-bearing
  // one. `codex exec` narrates itself on stderr: it echoes the prompt, and then
  // it reads files and prints their contents while it works. The prompt here is
  // a diff of this very module, so the second real run classified a *successful*
  // exploration as a usage error — the reviewer had quoted the classifier's own
  // patterns back at it, first from the prompt and then from the repository.
  if (exitCode === 0 && out) return null;

  // Second defence: read only the lines the CLI writes about itself. A file it
  // happened to print cannot produce one, because its content arrives quoted,
  // indented or diff-prefixed rather than at the head of a line.
  //
  // The prompt is subtracted as well, and joined with a newline rather than a
  // space: raised in review that rejoining with a space can form a phrase
  // across the seam that neither side contained — `…rate ` + prompt +
  // `limit…` becoming `rate limit`.
  const strip = (text: string) => (prompt ? text.split(prompt).join("\n") : text);
  const all = `${strip(stdout)}\n${strip(stderr)}`
    .split("\n")
    .filter((line) => /^\s*(error\b|usage:)/i.test(line))
    .join("\n")
    .toLowerCase();

  // Checked before the exit code: a usage error also exits non-zero, and
  // "non-zero" is exactly the answer that hid this for months.
  if (/unexpected argument|unrecognized subcommand|unknown option|^usage: codex/m.test(all)) {
    return "cli-usage: the codex invocation is wrong for this CLI version";
  }
  if (/not supported when using codex with|model .* is not supported/.test(all)) {
    return "model-unsupported: this account cannot use the configured model";
  }
  // `usage limit` is Codex's own wording, captured verbatim on 2026-08-05:
  //   ERROR: You've hit your usage limit. Visit … or try again at Aug 11th, 2026 5:49 PM.
  // It matched none of the three patterns above, so eleven review rounds that
  // day recorded `failed (exit 1)` — true, and useless. The one string that
  // named the problem was discarded by the classifier that exists to name it.
  if (/rate limit|usage limit|quota|too many requests/.test(all)) {
    // "try again at <when>" is the whole of what the operator needs next.
    const until = all.match(/try again at ([^.\n]+)/)?.[1]?.trim();
    return until ? `limit until ${until}` : "limit";
  }
  if (/unauthorized|not logged|401|authentication/.test(all)) return "auth";
  if (exitCode !== 0) return `failed (exit ${exitCode})`;
  if (!out) return "empty output";
  return null;
}

/** What `callCodexReview` needs from the world, so a test can be the world. */
export type SpawnCodex = (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const spawnCodex: SpawnCodex = async (argv) => {
  const proc = Bun.spawn(argv, {
    // Explicit: the CLI announces "Reading additional input from stdin…" and
    // waits when it inherits an open one. Nothing here has anything to send it.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  // Bounded, and the subprocess is killed rather than abandoned. Raised in
  // review: the timeout covered provider fetches only, so a hung `npx` waited
  // for ever — and `Promise.allSettled` in `runReviewers` waits for every
  // reviewer, so one stuck process held up reviews that had already finished.
  const timer = setTimeout(() => proc.kill(), REVIEW_TIMEOUT_MS);

  // Raced, not merely killed. Raised in review: `proc.kill()` reaches the `npx`
  // wrapper, and the Codex process it launched can outlive it while still
  // holding the pipes — so awaiting the reads would block past the timeout it
  // was supposed to enforce. Losing the race is an answer.
  const expired = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`codex timed out after ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s`)),
      REVIEW_TIMEOUT_MS + 5_000,
    ).unref?.();
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      expired,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

export async function callCodexReview(
  reviewer: Reviewer,
  prompt: string,
  spawn: SpawnCodex = spawnCodex,
): Promise<ReviewerReport> {
  const model = reviewer.model || process.env.CODEX_MODEL || "gpt-5.6-sol";
  const fail = (error: string): ReviewerReport => ({ reviewerId: reviewer.id, label: "Codex", model, ok: false, error });
  const sent = `${CODEX_DIRECTIVE}\n\n${prompt}`;
  try {
    const { stdout, stderr, exitCode } = await spawn(codexArgv(model, sent));
    const out = stripAnsi(stdout).trim();
    // Stripped against what was actually sent, echo and all.
    const failure = classifyCodexFailure(exitCode, out, stripAnsi(stderr), sent);
    if (failure) return fail(failure);
    return { reviewerId: reviewer.id, label: "Codex", model, ok: true, content: out };
  } catch (err) {
    return fail(String(err).slice(0, 200));
  }
}

/**
 * The argv for a non-interactive Claude Code run.
 *
 * `--strict-mcp-config` with an empty config is load-bearing, not tidiness.
 * `~/.claude.json` defines `helyx` and `helyx-channel` as *global* MCP servers,
 * loaded by every `claude` in every directory. A reviewer that loaded them
 * would connect to the bot on every review — see `claudeEnv` for what that
 * costs.
 *
 * The config is passed inline rather than as `/dev/null`. That was the obvious
 * way to say "no servers" and the CLI rejects it:
 *
 *   Error: Invalid MCP configuration: MCP config is not a valid JSON
 *
 * — an empty file is not an empty object, and the reviewer would have failed
 * before it was asked anything, the way the Codex reviewer did for months.
 *
 * There is deliberately **no** `--permission-mode plan` here. It was the
 * obvious way to say "this one only reads", and the first review run through
 * this code path reported what it actually does: plan mode injects Claude
 * Code's own plan workflow into the system prompt — write a plan file, launch
 * Explore subagents, end the turn with `ExitPlanMode` or `AskUserQuestion` —
 * which contradicts every clause of `CLAUDE_DIRECTIVE` below. A reviewer that
 * complied would answer with a plan-approval request, exit 0 with non-empty
 * stdout, and be filed as a successful review. That is precisely the failure
 * `CODEX_DIRECTIVE` exists to prevent, arriving through the flag meant to make
 * the reviewer safer.
 *
 * But plan mode *was* enforcing read-only, and the first replacement for it —
 * denying `Edit`, `Write` and `NotebookEdit` — was much weaker than it looked.
 * The reviewer inherits the caller's working directory, so this repository's
 * `.claude/settings.local.json` applies, and it allows 379 `Bash(...)` patterns
 * including `docker compose:*` and `git commit -m ':*`. An allowlisted tool
 * does not prompt, and under `-p` there is nobody to prompt. A reviewer that
 * decided to verify a fix by running `helyx bounce` would be the same class of
 * harm as the `CHANNEL_SOURCE` incident this flow exists to prevent.
 *
 * So the denial below is long, and it is a deny-list because the obvious
 * alternative does not work. `--allowed-tools Read Grep Glob` reads like a
 * restriction and is not one: asked directly, a CLI started that way reports
 * Bash, Write, Task, Workflow and Skill all still available. Only
 * `--disallowed-tools` denies, and it has to name the delegation routes as well
 * as the direct ones — with only the three write tools denied, the reviewer
 * reported it could still reach a shell through `Monitor` and a subagent
 * through `TaskCreate`. With the list as it stands it reports "No Bash,
 * Edit/Write, fetch, or subagent tool". Anything the CLI gains later is allowed
 * by default; that is the standing cost of a deny-list, and the reason this
 * comment records how it was checked.
 *
 * Known and not fixed here — two channels from the host into the reviewer:
 *
 * - `--settings` is documented as loading *additional* settings ("Path to a
 *   settings JSON file or a JSON string to load additional settings from").
 *   It adds a layer, it does not replace one, and there is no `--strict-settings`
 *   to match `--strict-mcp-config`. So `~/.claude/settings.json` and its hooks
 *   still load. An earlier version of this comment claimed the opposite, which
 *   is worse than the gap it described: `--bare` is the only flag that would
 *   do it, and it forces API-key auth, which defeats the whole point of a
 *   reviewer on the subscription.
 * - the *project* `.claude/settings.json` applies as well, so this repository's
 *   `keryx security check-input` hook runs on the review prompt. It degrades
 *   the prompt rather than breaking the run — the review that found the
 *   plan-mode defect was produced with that hook firing.
 */

/**
 * Everything that can run a command, change a file, reach the network, or hand
 * the work to something that can. Verified against the CLI, not assumed.
 */
export const CLAUDE_DENIED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Task",
  "Agent",
  "Workflow",
  "Skill",
  "Monitor",
  "WebFetch",
  "WebSearch",
  "EnterWorktree",
  "ExitWorktree",
  "RemoteTrigger",
  "CronCreate",
  "CronDelete",
  "PushNotification",
  "SendMessage",
  "DesignSync",
  "TaskCreate",
  "TaskUpdate",
  "TaskStop",
  "Artifact",
] as const;

export const CLAUDE_EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

export function claudeArgv(model: string, prompt: string): string[] {
  return [
    "claude",
    "-p",
    // Both of these are variadic. Whatever follows their values is read as one
    // more value, so the prompt must never sit directly behind one — measured
    // twice, once as `Permission deny rule "single" matches no known tool` and
    // once as the CLI trying to open the prompt as an MCP config file. `--model`
    // takes exactly one value, so it is what stands between them and the
    // prompt, and it stays last for that reason rather than by taste.
    "--disallowed-tools",
    ...CLAUDE_DENIED_TOOLS,
    "--strict-mcp-config",
    "--mcp-config",
    CLAUDE_EMPTY_MCP_CONFIG,
    "--model",
    model,
    prompt,
  ];
}

/**
 * The variables a nested `claude` must NOT inherit, and why each one.
 *
 * `ANTHROPIC_*` — the session this runs inside may be bound to a third-party
 * provider (GLM, Kimi, the local Ollama proxy). Inheriting those would route
 * the "independent" review straight back through the model it is supposed to be
 * independent of, and the report would still be labelled Claude. Verified on
 * 2026-08-08: with `ANTHROPIC_API_KEY` left in place the CLI answers
 * `Not logged in · Please run /login`; with all four cleared it answers on the
 * subscription.
 *
 * `CHANNEL_SOURCE` — the expensive one. `scripts/run-cli.sh:137` starts a
 * session as `CHANNEL_SOURCE=remote claude …`, a prefix assignment, so the
 * variable lives in the session's own environment and every child process
 * inherits it. `channel/index.ts:81` reads it and registers the process as a
 * *remote session for its project path* — the same row the parent session
 * holds. On 2026-08-08 a single hand-run `claude -p` did exactly this: the bot
 * logged `sessionId 3 … trigger:"disconnect"` at 07:45:47 while the parent was
 * still working, the parent's next tool call never returned, and three operator
 * messages sat in a queue for 22 minutes routed `mode:"disconnected"`. A
 * reviewer runs on every review, so this would not have been a one-off.
 *
 * `CLAUDE_CONFIG_DIR` and the `CLAUDE_CODE_*` family — a settings file can
 * carry `env.ANTHROPIC_BASE_URL` of its own, which is how `claude-code-router`
 * hijacked every session on this machine once already. Stripping the variables
 * while leaving a pointer to a config that re-sets them would route the
 * "independent" review back through the third-party provider *and still label
 * the report Claude*, which is the one failure this list exists to prevent.
 */
export const CLAUDE_STRIPPED_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "CHANNEL_SOURCE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDECODE",
] as const;

/**
 * The environment for the reviewer CLI: the caller's, minus the above.
 *
 * The `CLAUDE_CODE_*` prefix is swept rather than listed: the list would be a
 * table, and this repository has been bitten by tables that fell behind.
 */
export function claudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FORCE_COLOR: "0" };
  for (const key of CLAUDE_STRIPPED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  return env;
}

/**
 * Said to the Claude CLI, and only to it.
 *
 * Same reason `CODEX_DIRECTIVE` exists: a CLI reviewer reads the operator's own
 * `CLAUDE.md` and skills, and this repository's `CLAUDE.md` instructs any agent
 * asked for a review to run `scripts/review.ts` — which is what is calling it.
 * Without this the reviewer would try to convene the reviewers.
 */
export const CLAUDE_DIRECTIVE =
  "You are running non-interactively as one independent reviewer. Output the review itself as your " +
  "final message. Do not delegate to other reviewers or run any review script, do not ask questions, " +
  "do not route to another skill or orchestrator, and do not create or write any files.";

/**
 * Why a Claude CLI run produced nothing.
 *
 * Deliberately not `classifyCodexFailure`: that function subtracts the prompt
 * and reads only self-describing lines because `codex exec` narrates itself
 * onto stderr while it works. `claude -p` does not, so the wording it uses for
 * the two states that matter — a rejected login and a spent limit — can be read
 * directly. Null means the run succeeded.
 */
export function classifyClaudeFailure(exitCode: number, stdout: string, stderr: string): string | null {
  const out = stdout.trim();

  // Checked before the "it answered" short-circuit, and this ordering is the
  // point. `claude -p` prints its refusal to *stdout* and can exit 0 doing it:
  //
  //   Not logged in · Please run /login
  //
  // Under the Codex-style short-circuit that is a successful review whose
  // content is the login error — recorded, shown to the operator as this
  // reviewer's opinion, and counted by `pickMode` as a reason not to fall back
  // to reviewing the change ourselves.
  //
  // Bounded by length *and* anchored to the start, so it stays a refusal and
  // not a filter on reviews. Unanchored it was a filter: a terse reviewer
  // writing "The invalid api key path is unhandled." is 38 characters, matches,
  // and would be discarded as an auth failure — and the diff under review
  // contains the CLI's own refusal text four times, which is exactly the sort
  // of string a reviewer quotes back.
  if (out.length < 200 && /^(not logged in|please run \/login|invalid api key)/i.test(out)) {
    return "auth: the Claude CLI is not logged in for this environment";
  }

  // It answered. Same reason as the Codex path: a review that happens to quote
  // the word "limit" is still a review.
  if (exitCode === 0 && out) return null;

  const all = `${stdout}\n${stderr}`.toLowerCase();
  if (/not logged in|please run \/login|invalid api key|authentication_error|unauthorized/.test(all)) {
    return "auth: the Claude CLI is not logged in for this environment";
  }
  if (/usage limit|rate limit|quota|too many requests/.test(all)) {
    const until = all.match(/try again at ([^.\n]+)/)?.[1]?.trim();
    return until ? `limit until ${until}` : "limit";
  }
  if (/credit balance|insufficient/.test(all)) return "limit/balance";
  if (exitCode !== 0) return `failed (exit ${exitCode})`;
  return "empty output";
}

/** What `callClaudeReview` needs from the world, so a test can be the world. */
export type SpawnClaude = (
  argv: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const spawnClaude: SpawnClaude = async (argv, env) => {
  const proc = Bun.spawn(argv, {
    // The CLI waits on an inherited stdin the same way Codex does, and nothing
    // here has anything to send it.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const timer = setTimeout(() => proc.kill(), REVIEW_TIMEOUT_MS);
  const expired = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`claude timed out after ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s`)),
      REVIEW_TIMEOUT_MS + 5_000,
    ).unref?.();
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      expired,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Whether the CLI exists here, as an argument rather than as a fact.
 *
 * It was `Bun.which("claude")` inline, and that reached past the `spawn` seam:
 * on a machine without the CLI — CI, and the bot image — the four tests that
 * inject a fake spawn never got to use it, because the function had already
 * decided the world was empty. A test that supplies the world should not be
 * overruled by the real one. Caught by CI, which is exactly the machine the
 * check was added for.
 */
export type WhichClaude = () => string | null;

export async function callClaudeReview(
  reviewer: Reviewer,
  prompt: string,
  spawn: SpawnClaude = spawnClaude,
  which: WhichClaude = () => Bun.which("claude"),
): Promise<ReviewerReport> {
  const model = reviewer.model || CLAUDE_DEFAULT_MODEL;
  const fail = (error: string): ReviewerReport => ({ reviewerId: reviewer.id, label: "Claude", model, ok: false, error });
  const sent = `${CLAUDE_DIRECTIVE}\n\n${prompt}`;
  // Asked before spawning rather than after failing. The bot image installs
  // git, curl and ca-certificates and no CLIs, and `defaultReviewers` enables
  // this reviewer for every caller — so a Telegram-triggered review would spawn
  // a process that can only fail. The report is the same either way; this skips
  // the spawn.
  if (!which()) {
    return fail("unavailable: the claude CLI is not installed in this environment (host-only reviewer)");
  }
  try {
    const { stdout, stderr, exitCode } = await spawn(claudeArgv(model, sent), claudeEnv());
    const out = stripAnsi(stdout).trim();
    const failure = classifyClaudeFailure(exitCode, out, stripAnsi(stderr));
    if (failure) return fail(failure);
    return { reviewerId: reviewer.id, label: "Claude", model, ok: true, content: out };
  } catch (err) {
    const text = String(err);
    // The bot image installs git, curl and ca-certificates and no CLIs, so a
    // review triggered from Telegram rather than from the host reaches this.
    // Said plainly, because "ENOENT" in a reviewer report reads as a bug in the
    // reviewer rather than as "this reviewer does not exist in here". The
    // subscription login lives in the operator's home directory, so the fix is
    // not to add the binary to the image.
    if (/ENOENT|not found|No such file/i.test(text)) {
      return fail("unavailable: the claude CLI is not installed in this environment (host-only reviewer)");
    }
    return fail(text.slice(0, 200));
  }
}

/** The provider row lookup, so a test does not need a database to have a provider. */
export type GetProvider = (id: number) => Promise<Provider | null>;

export async function callProviderReview(
  reviewer: Reviewer,
  prompt: string,
  doFetch: typeof fetch = fetch,
  getProvider: GetProvider = (id) => providerService.get(id),
): Promise<ReviewerReport> {
  const prov = await getProvider(reviewer.providerId ?? -1);
  if (!prov) return { reviewerId: reviewer.id, label: `provider#${reviewer.providerId}`, model: reviewer.model, ok: false, error: "unknown provider" };
  const label = prov.name;

  // The route the vendor actually has, rather than one derived by chopping a
  // suffix off the Anthropic URL. `known` travels to the failure message: when
  // the fallback answered, the operator needs to know it was a guess.
  const route = openAiRouteFor(prov.base_url);

  // The vendor hint goes on the failures a wrong route can cause, and only
  // those. It started on `http <status>` alone, which missed the HTML error
  // page (`invalid json`) and the refused connection (`network: …`) — the two
  // messages that give the next reader nothing to go on. Then it went on every
  // failure, which was worse in the other direction: `limit/balance` is a real
  // 429 from the vendor's billing layer and `REVIEW_TRUNCATED` is a well-formed
  // completion, so both of them *prove* the route was right, and both were
  // being annotated with the URL as though it were the suspect.
  //
  // The narrower set also keeps `base_url` out of the common transient path. It
  // reaches Telegram and the `run.json` artifacts, and a provider registered
  // one day with a credential in its query string should not be logged on every
  // flaky connection.
  const routeShaped = (error: string): boolean =>
    error.startsWith("http ") || error.startsWith("network:") || error === "invalid json";
  const fail = (error: string): ReviewerReport => ({
    reviewerId: reviewer.id,
    label,
    model: reviewer.model,
    ok: false,
    error: route.known || !routeShaped(error) ? error : `${error} (unmapped vendor ${prov.base_url})`,
  });

  const ask = async (maxTokens: number): Promise<{ status: number; body: string } | string> => {
    let res: Response;
    try {
      res = await doFetch(route.url, {
        method: "POST",
        // From the provider's own auth_scheme rather than an assumption. This
        // said `Bearer` unconditionally, which is right for DeepSeek and a 401
        // for the first api_key provider registered — reported, of course, as
        // "limit/auth".
        headers: providerAuthHeaders(prov.auth_token, prov.auth_scheme),
        body: JSON.stringify({
          model: reviewer.model,
          messages: [
            { role: "system", content: REVIEW_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
      });
    } catch (err) {
      return `network: ${String(err).slice(0, 200)}`;
    }

    // Inside the guard, because the abort signal covers the body too. This read
    // sat outside it, so a timeout after the headers arrived threw past this
    // function entirely and surfaced from `Promise.allSettled` labelled with
    // the reviewer's id instead of its name — an error message that named
    // neither the provider nor the cause.
    try {
      return { status: res.status, body: await res.text() };
    } catch (err) {
      return `network: ${String(err).slice(0, 200)}`;
    }
  };

  let answer = await ask(REVIEW_MAX_TOKENS);
  if (typeof answer === "string") return fail(answer);

  // One retry, at the figure that worked before this flow raised it. A provider
  // whose model cannot produce 32,000 tokens should not become a permanent
  // failure because a different provider's model needed the room.
  if (answer.status === 400 && isBudgetRejection(answer.body)) {
    const retried = await ask(REVIEW_MAX_TOKENS_FALLBACK);
    if (typeof retried === "string") return fail(retried);
    answer = retried;
  }

  const body = answer.body;
  if (answer.status < 200 || answer.status >= 300) {
    return isProviderLimitError(answer.status, body) ? fail("limit/balance") : fail(`http ${answer.status}`);
  }
  let data: { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    return fail("invalid json");
  }

  // Content first, envelope second, and the order is the fix.
  //
  // The envelope check used to run before this, so a body that carried both a
  // review and an empty `"error": {}` — truthy to `providerErrorInBody`, which
  // stringifies it to `"{}"` — threw the review away and reported the failure
  // as two braces. Reading the content first costs the z.ai case nothing: that
  // body has no `choices` at all, so it still falls through to the envelope and
  // is still reported as `404 NOT_FOUND`.
  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim() ?? "";
  if (content) return { reviewerId: reviewer.id, label, model: reviewer.model, ok: true, content };

  // Nothing was said. Now the body gets to explain itself.
  const announced = providerErrorInBody(body);
  if (announced) {
    // Classified against the whole body, displayed from `announced`. The
    // machine-readable half of an OpenAI error envelope lives in siblings of
    // `message` — `"type":"insufficient_quota"`, `"code":"billing_hard_limit_reached"`
    // — so classifying the extracted sentence alone reports a spent quota as a
    // generic error, and `failureHidesFromProbe` then leaves the reviewer
    // marked available.
    return isProviderLimitError(answer.status, body) ? fail("limit/balance") : fail(announced);
  }

  // The distinction the old "empty response" hid. A reasoning model that runs
  // out of budget mid-thought returns exactly this: 200, well-formed,
  // finish_reason "length", nothing said. Reported as what it is, so the next
  // person does not go looking at the account.
  return fail(choice?.finish_reason === "length" ? REVIEW_TRUNCATED : "empty response");
}

/**
 * The prompt a reviewer actually receives: the request, and the code.
 *
 * This did not exist. `runReviewers` passed the caller's sentence through
 * untouched, so a provider model was asked to review a pull request and shown
 * nothing — and said so, which is how the defect was finally noticed. CLAUDE.md
 * has claimed all along that "each provider model reads the git diff itself
 * from the prompt"; a model can only read what is in the prompt, and nothing
 * put it there.
 *
 * Building it here rather than in `scripts/review.ts` because three callers
 * reach `runReviewers` — the script, the MCP tool and the Telegram command —
 * and each would otherwise need its own copy of this knowledge.
 */
/**
 * Cut to `budget` **bytes**, never through the middle of a character.
 *
 * Bytes because that is what the constraint is: `MAX_ARG_STRLEN` is 128 KiB of
 * argument, not 128 K characters. Counting characters, as this did, lets a diff
 * with enough non-ASCII in it pass a check it should have failed.
 *
 * Not through a character because the halves are not characters. `slice` counts
 * UTF-16 code units and an emoji is two of them; cutting between leaves an
 * unpaired surrogate in the text handed to the model. Raised in review, and a
 * diff of this codebase carries emoji in exactly the modules this flow touches.
 *
 * The decoder marks an incomplete trailing sequence with U+FFFD, which is the
 * signal that the cut landed inside a character — dropped rather than shipped.
 */
export function cutToBytes(text: string, budget: number): string {
  if (budget <= 0) return "";
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= budget) return text;
  const decoded = new TextDecoder("utf-8").decode(bytes.subarray(0, budget));
  return decoded.replace(/�+$/, "");
}

/** How many bytes this text costs on the wire and on the command line. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function buildReviewPrompt(
  request: string,
  diff: string,
  budget: number = REVIEW_DIFF_BUDGET_BYTES,
): string {
  const head = cutToBytes(request.trim(), REVIEW_REQUEST_BUDGET_BYTES) || "Review the changes below.";
  if (!diff.trim()) {
    return `${head}\n\n(No diff could be produced for this working tree. Say so rather than guessing.)`;
  }

  const size = byteLength(diff);
  const cut = size > budget;
  // Announced, not silent. A truncated diff that claims to be whole produces a
  // confident review of code the reviewer never saw.
  const body = cut ? cutToBytes(diff, budget) : diff;
  const note = cut
    ? `\n\n[diff truncated at ${budget} bytes of ${size}; review what is shown and say that the rest was not provided]`
    : "";

  return `${head}\n\n=== DIFF ===\n${body}${note}`;
}

/** What `runReviewers` needs from git, so a test can be git. */
export type ReadDiff = () => Promise<string>;

async function run(argv: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? out : "";
  } catch {
    return "";
  }
}

/**
 * The change under review: everything since this branch left the trunk,
 * committed or not.
 *
 * `.metaproject` is excluded. It is flow paperwork — descriptions, plans,
 * acceptance criteria — and on a managed change it is larger than the code,
 * so including it spends the reviewer's attention and the diff budget on prose
 * the reviewer was not asked about.
 */
export const gitReviewDiff: ReadDiff = async () => {
  const untracked = await untrackedDiff();
  for (const trunk of ["origin/main", "main"]) {
    const base = (await run(["git", "merge-base", "HEAD", trunk])).trim();
    if (!base) continue;
    const tracked = await run(["git", "diff", base, "--", ".", ":!.metaproject"]);
    if (tracked.trim() || untracked.trim()) return `${tracked}${untracked}`;
  }
  return untracked;
};

/**
 * New files that git has not been told about yet, as a diff.
 *
 * Raised in review, and demonstrated by this very flow: `git diff <base>` shows
 * committed, staged and tracked working-tree changes, and never a file that has
 * only been created. Both reviewers were shown "the branch" while the new test
 * suites were invisible to them — one of them noticed the absence and reported
 * it as missing test coverage.
 *
 * `--no-index` against `/dev/null` produces the same shape git would produce
 * once the file were added, so the reviewer sees one consistent document.
 */
async function untrackedDiff(): Promise<string> {
  const listing = await run([
    "git", "ls-files", "--others", "--exclude-standard", "--", ".", ":!.metaproject",
  ]);
  const paths = listing.split("\n").map((p) => p.trim()).filter(Boolean);

  let out = "";
  for (const path of paths) {
    // Exits 1 when the files differ, which is always — `run` returns "" on a
    // non-zero exit, so this one is spawned directly.
    const diff = await runAllowingDifference(["git", "diff", "--no-index", "--", "/dev/null", path]);
    out += diff;
  }
  return out;
}

async function runAllowingDifference(argv: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return text;
  } catch {
    return "";
  }
}

/**
 * How much diff this reviewer's transport can carry.
 *
 * The 100 KB figure is about argv, not about the model: a CLI reviewer receives
 * the prompt as one command-line argument and Linux caps that at 128 KiB. So it
 * binds `claude` for exactly the same reason it binds `codex`, and an HTTP
 * provider — which has no argv — still gets the larger budget.
 */
export function budgetFor(reviewer: Reviewer): number {
  return reviewer.kind === "provider" ? REVIEW_DIFF_BUDGET_BYTES_PROVIDER : REVIEW_DIFF_BUDGET_BYTES;
}

async function runOne(reviewer: Reviewer, prompt: string): Promise<ReviewerReport> {
  if (reviewer.kind === "codex") return callCodexReview(reviewer, prompt);
  if (reviewer.kind === "claude") return callClaudeReview(reviewer, prompt);
  return callProviderReview(reviewer, prompt);
}

/**
 * Run a single reviewer (used by the `/codex_review` path).
 *
 * It builds the prompt for the same reason `runReviewers` does. Raised in
 * review: moving the diff into `runReviewers` left this caller behind, and
 * `bot/commands/codex.ts` passes the operator's typed sentence — so the one
 * path an operator triggers by hand would have stayed the blind one.
 */
export async function runSingleReviewer(
  reviewer: Reviewer,
  request: string,
  readDiff: ReadDiff = gitReviewDiff,
): Promise<ReviewerReport> {
  return runOne(reviewer, buildReviewPrompt(request, await readDiff(), budgetFor(reviewer)));
}

/**
 * Run every enabled reviewer concurrently and collect the reports.
 *
 * A reviewer that errors is a report with `ok: false`; it does not take the
 * others down. `mode` is decided by whether any succeeded.
 *
 * `request` is what the operator asked for — a sentence, not a prompt. The diff
 * is attached here; callers used to be silently responsible for that and none
 * of them did it, so every provider review was made blind.
 */
export async function runReviewers(
  request: string,
  readDiff: ReadDiff = gitReviewDiff,
): Promise<ReviewRunResult> {
  const reviewers = (await getReviewers()).filter((r) => r.enabled);
  if (reviewers.length === 0) return { mode: "self", reports: [] };
  // The diff is read once and shared: every reviewer is asked about the same
  // change, and one `git diff` is enough for all of them. The *prompt* is built
  // per reviewer, because the two transports do not have the same ceiling.
  const diff = await readDiff();
  const settled = await Promise.allSettled(
    reviewers.map((r) => runOne(r, buildReviewPrompt(request, diff, budgetFor(r)))),
  );
  const reports = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { reviewerId: reviewers[i].id, label: reviewers[i].id, model: reviewers[i].model, ok: false, error: String(s.reason ?? "error").slice(0, 200) },
  );
  return { mode: pickMode(reports), reports };
}

/**
 * What the CLI prints, as data.
 *
 * The shape is a contract, not a preference: `CLAUDE.md` tells every agent in
 * this repository to run `scripts/review.ts` and to treat the single line
 * `SELF` as "every reviewer is down, review it yourself". A stray line in the
 * wrong place changes how the whole repo reviews code, so the decision lives
 * here where a test can hold it still.
 */
export function reviewConsoleLines(result: ReviewRunResult): string[] {
  if (result.mode === "self") return ["SELF"];
  const lines: string[] = [];
  for (const report of result.reports) {
    // Both fallbacks exist because the alternative is printing the literal
    // word "undefined" into a contract other agents parse. Raised in review;
    // neither shape is reachable from `runOne` today, and neither is worth
    // depending on that.
    lines.push(
      report.ok
        ? `\n===== ${report.label} (${report.model}) =====\n\n${report.content ?? "(reported nothing)"}`
        : `\n[${report.label} (${report.model})] unavailable: ${report.error ?? "no reason given"}`,
    );
  }
  return lines;
}

/**
 * Whether a recorded failure is one a live probe cannot see.
 *
 * Raised in review: overriding the probe on *any* failed last run means one
 * flaky network timeout marks a reviewer unavailable until somebody happens to
 * run a successful review, which may be hours away.
 *
 * The distinction that fixes it is not recency — a spent quota lasts six days
 * and a stale record of it is still true — but *kind*. A limit, a rejected
 * login or an unusable model are exactly the states a login probe reports as
 * healthy; a timeout or a bare non-zero exit is not evidence about anything the
 * probe cannot check for itself.
 */
export function failureHidesFromProbe(error: string | null): boolean {
  if (!error) return false;
  return /\blimit\b|\bquota\b|\bauth\b|unauthorized|not logged|model-unsupported|cli-usage/i.test(error);
}

/** Availability for `/reviewers` — Codex login state, provider balances. */
export async function getReviewerStatuses(): Promise<ReviewerStatus[]> {
  const reviewers = await getReviewers();
  // What each reviewer did the last time one actually ran. A login probe
  // answered "logged in" for six days while every run was refused for a spent
  // quota; a record of the last real run cannot disagree with reality that way.
  const lastRun = await lastOutcomeByReviewer().catch(() => new Map<string, ReviewerOutcome>());
  const out: ReviewerStatus[] = [];
  for (const r of reviewers) {
    if (r.kind === "codex") {
      let available = false;
      let detail = "unknown";
      try {
        const proc = Bun.spawn(["npx", "@openai/codex", "login", "status"], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        const raw = stripAnsi(await new Response(proc.stdout).text()).trim().toLowerCase();
        await proc.exited;
        available = raw.includes("logged in") && !raw.includes("not logged");
        detail = available ? "logged in" : "not logged in";
      } catch {
        detail = "status check failed";
      }
      const last = lastRun.get(r.id);
      if (last && !last.ok) {
        if (failureHidesFromProbe(last.error)) {
          // Logged in and unable to review is the case this exists for.
          available = false;
          detail = last.error ?? "last run failed";
        } else {
          // A transient failure is worth showing and not worth overriding: the
          // probe can still answer for itself.
          detail = `${detail} · последний прогон: ${last.error ?? "не удался"}`;
        }
      }
      out.push({ id: r.id, label: "Codex", model: r.model, available, probed: true, detail });
      continue;
    }

    if (r.kind === "claude") {
      // No probe, and deliberately none. The only thing that proves this
      // reviewer works is a headless run, and a headless run spends the
      // operator's own subscription quota — the same pool the sessions draw
      // from. `claude --version` would prove the binary exists and nothing
      // about the login, which is precisely the green tick this file's
      // `probed` field was added to stop telling.
      //
      // Because there is no probe, a failed last run is the *only* evidence
      // there is, and it decides. The Codex branch above may keep a reviewer
      // green through a transient failure because a live probe disagrees with
      // it; here nothing disagrees with it. Raised in review: the borrowed
      // expression left `available: true` next to a detail line reading
      // "последний прогон не удался" — the green tick meaning "nobody asked"
      // that `probed` was added to abolish.
      const last = lastRun.get(r.id);
      out.push({
        id: r.id,
        label: "Claude",
        model: r.model,
        available: last ? last.ok : true,
        probed: Boolean(last),
        detail: last ? (last.ok ? "последний прогон: ок" : (last.error ?? "последний прогон не удался")) : "не проверялся",
      });
      continue;
    }

    const prov = await providerService.get(r.providerId ?? -1);
    if (!prov) {
      out.push({ id: r.id, label: r.id, model: r.model, available: false, probed: true, detail: "unknown provider" });
      continue;
    }
    let available = true;
    let detail = "ok";
    let probed = false;
    // DeepSeek exposes a balance endpoint; the others get a best-effort pass.
    if (prov.name.toLowerCase().includes("deepseek")) {
      try {
        const base = normalizeProviderBaseUrl(prov.base_url);
        const res = await fetch(`${base}/user/balance`, {
          headers: { Authorization: `Bearer ${prov.auth_token}` },
          signal: AbortSignal.timeout(8_000),
        });
        const data = (await res.json()) as { is_available?: boolean; balance_infos?: Array<{ total_balance?: string }> };
        const total = parseFloat(data.balance_infos?.[0]?.total_balance ?? "0");
        available = data.is_available !== false && total > 0;
        detail = available ? `balance $${total.toFixed(2)}` : "no balance";
        probed = true;
      } catch {
        detail = "balance check failed";
        probed = true;
      }
    }

    const last = lastRun.get(r.id);
    if (last) {
      probed = true;
      if (!last.ok) {
        if (failureHidesFromProbe(last.error)) {
          available = false;
          detail = last.error ?? "last run failed";
        } else {
          detail = `${detail} · последний прогон: ${last.error ?? "не удался"}`;
        }
      }
    }
    if (!probed) detail = "не проверялся";
    out.push({ id: r.id, label: prov.name, model: r.model, available, probed, detail });
  }
  return out;
}

export const reviewerService = { getReviewers, setReviewers, runReviewers, runSingleReviewer, getReviewerStatuses };

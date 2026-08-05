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
import { providerService, providerAuthHeaders, type Provider } from "./provider-service.ts";
import { stripAnsi } from "../utils/terminal.ts";

export type ReviewerKind = "codex" | "provider";

export interface Reviewer {
  /** Stable id used by `/reviewers remove <id>`. "codex" or "provider:<n>". */
  id: string;
  kind: ReviewerKind;
  /** `providers.id` — only meaningful for kind === "provider". */
  providerId?: number | null;
  /** Codex model name, or the provider's model id. */
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
  if (/rate limit|quota|too many requests/.test(all)) return "limit";
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
  const fail = (error: string): ReviewerReport => ({ reviewerId: reviewer.id, label, model: reviewer.model, ok: false, error });

  const baseUrl = normalizeProviderBaseUrl(prov.base_url);

  const ask = async (maxTokens: number): Promise<{ status: number; body: string } | string> => {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/chat/completions`, {
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
  try {
    const data = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim() ?? "";
    if (!content) {
      // The distinction the old "empty response" hid. A reasoning model that
      // runs out of budget mid-thought returns exactly this: 200, well-formed,
      // finish_reason "length", nothing said. Reported as what it is, so the
      // next person does not go looking at the account.
      return fail(choice?.finish_reason === "length" ? REVIEW_TRUNCATED : "empty response");
    }
    return { reviewerId: reviewer.id, label, model: reviewer.model, ok: true, content };
  } catch {
    return fail("invalid json");
  }
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

/** How much diff this reviewer's transport can carry. */
export function budgetFor(reviewer: Reviewer): number {
  return reviewer.kind === "codex" ? REVIEW_DIFF_BUDGET_BYTES : REVIEW_DIFF_BUDGET_BYTES_PROVIDER;
}

async function runOne(reviewer: Reviewer, prompt: string): Promise<ReviewerReport> {
  return reviewer.kind === "codex" ? callCodexReview(reviewer, prompt) : callProviderReview(reviewer, prompt);
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

/** Availability for `/reviewers` — Codex login state, provider balances. */
export async function getReviewerStatuses(): Promise<ReviewerStatus[]> {
  const reviewers = await getReviewers();
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
      out.push({ id: r.id, label: "Codex", model: r.model, available, detail });
      continue;
    }

    const prov = await providerService.get(r.providerId ?? -1);
    if (!prov) {
      out.push({ id: r.id, label: r.id, model: r.model, available: false, detail: "unknown provider" });
      continue;
    }
    let available = true;
    let detail = "ok";
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
      } catch {
        detail = "balance check failed";
      }
    }
    out.push({ id: r.id, label: prov.name, model: r.model, available, detail });
  }
  return out;
}

export const reviewerService = { getReviewers, setReviewers, runReviewers, runSingleReviewer, getReviewerStatuses };

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
import { providerService } from "./provider-service.ts";
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
const REVIEW_TIMEOUT_MS = 120_000;

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

async function callCodexReview(reviewer: Reviewer, prompt: string): Promise<ReviewerReport> {
  const model = reviewer.model || process.env.CODEX_MODEL || "gpt-5.6-sol";
  const fail = (error: string): ReviewerReport => ({ reviewerId: reviewer.id, label: "Codex", model, ok: false, error });
  try {
    const proc = Bun.spawn(["npx", "@openai/codex", "--no-interactive", "-m", model, prompt], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const out = stripAnsi(stdout).trim();
    const err = stripAnsi(stderr).trim().toLowerCase();
    const isLimit =
      exitCode !== 0 || !out || /rate limit|quota|unauthorized|not logged/.test(err) || /rate limit/i.test(out);
    if (isLimit) return fail("limit/auth/unavailable");
    return { reviewerId: reviewer.id, label: "Codex", model, ok: true, content: out };
  } catch (err) {
    return fail(String(err).slice(0, 200));
  }
}

async function callProviderReview(reviewer: Reviewer, prompt: string): Promise<ReviewerReport> {
  const prov = await providerService.get(reviewer.providerId ?? -1);
  if (!prov) return { reviewerId: reviewer.id, label: `provider#${reviewer.providerId}`, model: reviewer.model, ok: false, error: "unknown provider" };
  const label = prov.name;
  const fail = (error: string): ReviewerReport => ({ reviewerId: reviewer.id, label, model: reviewer.model, ok: false, error });

  const baseUrl = normalizeProviderBaseUrl(prov.base_url);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${prov.auth_token}` },
      body: JSON.stringify({
        model: reviewer.model,
        messages: [
          { role: "system", content: REVIEW_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(`network: ${String(err).slice(0, 200)}`);
  }

  const body = await res.text();
  if (!res.ok) {
    return isProviderLimitError(res.status, body) ? fail("limit/balance") : fail(`http ${res.status}`);
  }
  try {
    const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) return fail("empty response");
    return { reviewerId: reviewer.id, label, model: reviewer.model, ok: true, content };
  } catch {
    return fail("invalid json");
  }
}

async function runOne(reviewer: Reviewer, prompt: string): Promise<ReviewerReport> {
  return reviewer.kind === "codex" ? callCodexReview(reviewer, prompt) : callProviderReview(reviewer, prompt);
}

/** Run a single reviewer (used by the legacy /codex_review path). */
export async function runSingleReviewer(reviewer: Reviewer, prompt: string): Promise<ReviewerReport> {
  return runOne(reviewer, prompt);
}

/**
 * Run every enabled reviewer concurrently and collect the reports.
 *
 * A reviewer that errors is a report with `ok: false`; it does not take the
 * others down. `mode` is decided by whether any succeeded.
 */
export async function runReviewers(prompt: string): Promise<ReviewRunResult> {
  const reviewers = (await getReviewers()).filter((r) => r.enabled);
  if (reviewers.length === 0) return { mode: "self", reports: [] };
  const settled = await Promise.allSettled(reviewers.map((r) => runOne(r, prompt)));
  const reports = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { reviewerId: reviewers[i].id, label: reviewers[i].id, model: reviewers[i].model, ok: false, error: String(s.reason ?? "error").slice(0, 200) },
  );
  return { mode: pickMode(reports), reports };
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

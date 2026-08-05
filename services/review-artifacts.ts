/**
 * Keeping what the reviewers said.
 *
 * `scripts/review.ts` ran every reviewer, printed each report to a terminal and
 * exited. The structure it threw away would have serialized directly, and the
 * receiver for it already existed: `keryx memory ingest --from-review <path>`
 * is in the memory module's CLI surface and nothing in this repository has ever
 * produced a file for it.
 *
 * What that cost, repeatedly and recently: a second review of a branch cannot
 * know what the first one said. One flow in this programme went three rounds,
 * and nothing but a chat log records what rounds one and two claimed or which
 * of it turned out to be wrong.
 *
 * The renderers are pure and take their clock and their git context as
 * arguments. Only `persistReviewRun` and `pruneReviewArtifacts` touch a disk,
 * and neither is allowed to fail the review that produced them: the review is
 * the product, this is a by-product.
 */

import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { REVIEW_TRUNCATED, type ReviewRunResult } from "./reviewer-service.ts";

/** The format version written into every record, so a reader never has to guess. */
export const ARTIFACT_VERSION = 1;

export interface GitContext {
  branch: string;
  head: string;
  mergeBase: string;
  /** Bytes of diff actually sent to the reviewers. */
  diffBytes: number;
}

export interface RunMeta {
  /** How the run started: a person, a schedule, a command. */
  trigger: string;
  /** The request as asked, not the assembled prompt. */
  prompt: string;
  git: GitContext;
  startedAt: number;
  finishedAt: number;
}

export interface ReviewArtifact {
  dir: string;
  runJson: string;
  reportMd: string;
}

/** Where artifacts live: outside the image, gitignored, beside the logs. */
export const DEFAULT_ARTIFACT_ROOT = "logs/reviews";

/** Directory-safe branch name. Slashes are the common case: `feat/x`. */
export function branchSlug(branch: string): string {
  const slug = branch.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "detached";
}

/**
 * The directory name for one run: sortable, and readable at a glance.
 *
 * Built from the run's own timestamp rather than from the clock, so two callers
 * cannot disagree about when a run happened and a test does not have to freeze
 * time globally to know where its files went.
 */
export function runDirName(meta: RunMeta): string {
  const stamp = new Date(meta.startedAt).toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `${stamp}-${branchSlug(meta.git.branch)}`;
}

export function renderRunJson(result: ReviewRunResult, meta: RunMeta): string {
  return JSON.stringify(
    {
      version: ARTIFACT_VERSION,
      startedAt: new Date(meta.startedAt).toISOString(),
      finishedAt: new Date(meta.finishedAt).toISOString(),
      durationMs: meta.finishedAt - meta.startedAt,
      trigger: meta.trigger,
      git: meta.git,
      prompt: meta.prompt,
      mode: result.mode,
      reports: result.reports.map((r) => ({
        reviewerId: r.reviewerId,
        label: r.label,
        model: r.model,
        ok: r.ok,
        // Recorded as a flag rather than left inside an error string. A
        // truncated answer arrives as `ok: false` with this exact error, and a
        // reader should not have to pattern-match prose to learn that the model
        // ran out of budget rather than refusing.
        truncated: r.error === REVIEW_TRUNCATED,
        content: r.content ?? null,
        error: r.error ?? null,
      })),
    },
    null,
    2,
  ) + "\n";
}

export function renderReportMd(result: ReviewRunResult, meta: RunMeta): string {
  const head = meta.git.head ? meta.git.head.slice(0, 8) : "unknown";
  const lines: string[] = [
    `# Review — ${meta.git.branch} @ ${head}`,
    "",
    `Version: ${ARTIFACT_VERSION}.0.0`,
    `Date: ${new Date(meta.startedAt).toISOString()}`,
    `Trigger: ${meta.trigger}`,
    `Diff: ${meta.git.diffBytes} bytes`,
    `Mode: ${result.mode}`,
    "",
    "## Request",
    "",
    meta.prompt.trim() || "(none)",
    "",
  ];

  for (const report of result.reports) {
    lines.push(`## ${report.label} (${report.model})`, "");
    if (report.ok && report.content) {
      lines.push(report.content.trim(), "");
      continue;
    }
    // An unavailable reviewer is part of the record. Omitting it would make a
    // one-reviewer round look like a one-reviewer configuration.
    const why = report.error === REVIEW_TRUNCATED ? `${report.error} (truncated)` : report.error ?? "no content";
    lines.push(`[unavailable] ${why}`, "");
  }

  if (result.reports.length === 0) {
    lines.push("_No reviewer was enabled for this run._", "");
  }

  return lines.join("\n");
}

/**
 * Write both files. Returns their paths, or null if nothing could be written.
 *
 * Never throws: the caller has already printed a review that succeeded, and a
 * full disk is not a reason to fail it.
 */
export async function persistReviewRun(
  result: ReviewRunResult,
  meta: RunMeta,
  root: string = DEFAULT_ARTIFACT_ROOT,
): Promise<ReviewArtifact | null> {
  const dir = join(root, runDirName(meta));
  try {
    await mkdir(dir, { recursive: true });
    const runJson = join(dir, "run.json");
    const reportMd = join(dir, "report.md");
    await writeFile(runJson, renderRunJson(result, meta), "utf-8");
    await writeFile(reportMd, renderReportMd(result, meta), "utf-8");
    return { dir, runJson, reportMd };
  } catch {
    return null;
  }
}

export interface ReviewerOutcome {
  ok: boolean;
  error: string | null;
  /** When the run that produced this outcome started. */
  at: string;
}

/**
 * What each reviewer actually did, last time anyone ran one.
 *
 * The honest answer to "is this reviewer available", and the reason this
 * function exists at all: asking a CLI about its own login answered
 * `Logged in using ChatGPT` for six days while every `codex exec` was refused
 * for a spent quota. A record of the last real run cannot disagree with reality
 * that way — it *is* reality, from the most recent time it was tested.
 *
 * Reads only the newest artifact. An older one describes a state that has since
 * been superseded, and merging several would invent a history nobody recorded.
 */
export async function lastOutcomeByReviewer(
  root: string = DEFAULT_ARTIFACT_ROOT,
): Promise<Map<string, ReviewerOutcome>> {
  const out = new Map<string, ReviewerOutcome>();

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return out;
  }

  const runs: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of entries) {
    const path = join(root, name, "run.json");
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) runs.push({ path, mtimeMs: info.mtimeMs });
  }
  if (runs.length === 0) return out;

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let parsed: { startedAt?: string; reports?: Array<{ reviewerId?: string; ok?: boolean; error?: string | null }> };
  try {
    parsed = JSON.parse(await Bun.file(runs[0]!.path).text());
  } catch {
    return out;
  }

  for (const report of parsed.reports ?? []) {
    if (!report.reviewerId) continue;
    out.set(report.reviewerId, {
      ok: report.ok === true,
      error: report.error ?? null,
      at: parsed.startedAt ?? "",
    });
  }
  return out;
}

export interface PruneOptions {
  maxAgeDays?: number;
  maxRuns?: number;
}

export const DEFAULT_MAX_AGE_DAYS = 30;
export const DEFAULT_MAX_RUNS = 100;

/**
 * Bound the directory, without losing the run someone is most likely to want.
 *
 * The newest run of every branch survives both limits. A branch reviewed once,
 * three months ago, is exactly the branch whose review nobody can reconstruct
 * from memory.
 */
export async function pruneReviewArtifacts(
  options: PruneOptions = {},
  root: string = DEFAULT_ARTIFACT_ROOT,
  now: number = Date.now(),
): Promise<{ removed: number }> {
  const maxAgeMs = (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { removed: 0 };
  }

  const runs: Array<{ name: string; path: string; mtimeMs: number; branch: string }> = [];
  for (const name of entries) {
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) continue;
    // `<iso stamp>-<branch slug>`: the stamp is fixed-width, so what follows it
    // is the branch.
    const branch = name.slice("2026-01-01T00-00-00".length + 1) || name;
    runs.push({ name, path, mtimeMs: info.mtimeMs, branch });
  }

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const protectedPaths = new Set<string>();
  const seenBranches = new Set<string>();
  for (const run of runs) {
    if (seenBranches.has(run.branch)) continue;
    seenBranches.add(run.branch);
    protectedPaths.add(run.path);
  }

  let removed = 0;
  let kept = 0;
  for (const run of runs) {
    const tooOld = now - run.mtimeMs > maxAgeMs;
    const overCount = kept >= maxRuns;
    if (protectedPaths.has(run.path) || (!tooOld && !overCount)) {
      kept++;
      continue;
    }
    await rm(run.path, { recursive: true, force: true }).catch(() => {});
    removed++;
  }

  return { removed };
}

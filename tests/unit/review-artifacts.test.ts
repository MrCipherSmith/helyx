/**
 * What survives a review.
 *
 * The pipeline ran, printed to a terminal and forgot. A second review of the
 * same branch could not know what the first had said, and `keryx memory ingest
 * --from-review` — a receiver that already existed — had never been given a
 * file to read.
 *
 * These drive the real renderers, the real writer against a real temporary
 * directory, and the real pruner.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderRunJson,
  renderReportMd,
  persistReviewRun,
  pruneReviewArtifacts,
  branchSlug,
  runDirName,
  ARTIFACT_VERSION,
  type RunMeta,
} from "../../services/review-artifacts.ts";
import { REVIEW_TRUNCATED, reviewConsoleLines, type ReviewRunResult } from "../../services/reviewer-service.ts";

const STARTED = Date.UTC(2026, 7, 5, 16, 30, 0);
const FINISHED = STARTED + 8 * 60_000;

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  trigger: "manual",
  prompt: "Review the latest changes on this branch.",
  git: { branch: "feat/error-stream-watch", head: "fc584edcafe", mergeBase: "bfad745beef", diffBytes: 84213 },
  startedAt: STARTED,
  finishedAt: FINISHED,
  ...over,
});

const twoReviewers: ReviewRunResult = {
  mode: "external",
  reports: [
    { reviewerId: "codex", label: "Codex", model: "gpt-5.6-sol", ok: false, error: "usage limit" },
    { reviewerId: "provider:4", label: "DeepSeek", model: "deepseek-v4-pro", ok: true, content: "No defects found." },
  ],
};

const dirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "helyx-reviews-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the machine-readable record", () => {
  test("parses back, and carries the run", () => {
    const parsed = JSON.parse(renderRunJson(twoReviewers, meta()));

    expect(parsed.version).toBe(ARTIFACT_VERSION);
    expect(parsed.trigger).toBe("manual");
    expect(parsed.mode).toBe("external");
    expect(parsed.durationMs).toBe(8 * 60_000);
    expect(parsed.git.branch).toBe("feat/error-stream-watch");
    expect(parsed.git.diffBytes).toBe(84213);
    expect(parsed.prompt).toContain("Review the latest changes");
    expect(parsed.reports).toHaveLength(2);
    expect(parsed.reports[1].content).toBe("No defects found.");
    expect(parsed.reports[0].error).toBe("usage limit");
  });

  test("truncation is a flag, not a string to pattern-match", () => {
    // A model that spent its whole budget before answering arrives as an error
    // whose text happens to say so. A reader of the record should not have to
    // recognise that sentence.
    const truncated: ReviewRunResult = {
      mode: "external",
      reports: [{ reviewerId: "provider:4", label: "DeepSeek", model: "deepseek-v4-pro", ok: false, error: REVIEW_TRUNCATED }],
    };

    const parsed = JSON.parse(renderRunJson(truncated, meta()));

    expect(parsed.reports[0].truncated).toBe(true);
    expect(JSON.parse(renderRunJson(twoReviewers, meta())).reports[0].truncated).toBe(false);
  });
});

describe("the readable record", () => {
  test("carries the version, the branch, the trigger and each reviewer", () => {
    const md = renderReportMd(twoReviewers, meta());

    expect(md).toContain("# Review — feat/error-stream-watch @ fc584edc");
    expect(md).toContain(`Version: ${ARTIFACT_VERSION}.0.0`); // the package standard's requirement
    expect(md).toContain("Trigger: manual");
    expect(md).toContain("## DeepSeek (deepseek-v4-pro)");
    expect(md).toContain("No defects found.");
  });

  test("an unavailable reviewer is recorded, not omitted", () => {
    // Otherwise a round in which one of two reviewers was down reads like a
    // one-reviewer configuration.
    const md = renderReportMd(twoReviewers, meta());

    expect(md).toContain("## Codex (gpt-5.6-sol)");
    expect(md).toContain("[unavailable] usage limit");
  });

  test("a run with no reviewer enabled says so", () => {
    const md = renderReportMd({ mode: "self", reports: [] }, meta());

    expect(md).toContain("No reviewer was enabled");
  });
});

describe("writing it down", () => {
  test("both files land in one directory named after the run", async () => {
    const root = tempRoot();

    const artifact = await persistReviewRun(twoReviewers, meta(), root);

    expect(artifact).not.toBeNull();
    expect(artifact!.dir).toBe(join(root, "2026-08-05T16-30-00-feat-error-stream-watch"));
    expect(existsSync(artifact!.runJson)).toBe(true);
    expect(readFileSync(artifact!.reportMd, "utf-8")).toContain("DeepSeek");
    expect(JSON.parse(readFileSync(artifact!.runJson, "utf-8")).mode).toBe("external");
  });

  test("a run where every reviewer failed is still recorded", async () => {
    // The case worth keeping most: it is the one where nobody read the change.
    const root = tempRoot();
    const allDown: ReviewRunResult = {
      mode: "self",
      reports: [{ reviewerId: "codex", label: "Codex", model: "gpt-5.6-sol", ok: false, error: "usage limit" }],
    };

    const artifact = await persistReviewRun(allDown, meta(), root);

    expect(JSON.parse(readFileSync(artifact!.runJson, "utf-8")).mode).toBe("self");
  });

  test("an unwritable root returns null instead of throwing", async () => {
    // The review already succeeded and has already been printed. A full disk is
    // not a reason to fail it.
    const root = join(tempRoot(), "file-not-a-directory");
    Bun.write(root, "x");

    const artifact = await persistReviewRun(twoReviewers, meta(), join(root, "nested"));

    expect(artifact).toBeNull();
  });
});

describe("bounding the directory", () => {
  const day = 24 * 60 * 60 * 1000;

  function run(root: string, name: string, ageDays: number): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    const when = new Date(Date.now() - ageDays * day);
    utimesSync(path, when, when);
    return path;
  }

  test("old runs go, and the newest of a branch never does", async () => {
    const root = tempRoot();
    const ancient = run(root, "2026-01-01T00-00-00-feat-old", 200);
    const recent = run(root, "2026-08-05T10-00-00-feat-new", 1);

    const { removed } = await pruneReviewArtifacts({ maxAgeDays: 30 }, root);

    // `feat-old` is 200 days past the limit and survives anyway: it is the only
    // review that branch ever had, and it is exactly the one nobody can
    // reconstruct from memory.
    expect(removed).toBe(0);
    expect(existsSync(ancient)).toBe(true);
    expect(existsSync(recent)).toBe(true);
  });

  test("an older run of a branch that has a newer one is pruned by age", async () => {
    const root = tempRoot();
    const older = run(root, "2026-01-01T00-00-00-feat-x", 200);
    const newer = run(root, "2026-08-05T10-00-00-feat-x", 1);

    const { removed } = await pruneReviewArtifacts({ maxAgeDays: 30 }, root);

    expect(removed).toBe(1);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });

  test("the count limit keeps the newest and drops the rest", async () => {
    const root = tempRoot();
    run(root, "2026-08-01T00-00-00-feat-y", 4);
    run(root, "2026-08-02T00-00-00-feat-y", 3);
    const newest = run(root, "2026-08-03T00-00-00-feat-y", 2);

    const { removed } = await pruneReviewArtifacts({ maxRuns: 1, maxAgeDays: 365 }, root);

    expect(removed).toBe(2);
    expect(existsSync(newest)).toBe(true);
  });

  test("a directory that does not exist is not an error", async () => {
    expect(await pruneReviewArtifacts({}, join(tempRoot(), "never-made"))).toEqual({ removed: 0 });
  });
});

describe("the console contract CLAUDE.md depends on", () => {
  test("every reviewer down is exactly one line, and it is SELF", () => {
    // The whole fallback in CLAUDE.md keys on this line. Persistence is a
    // by-product and must not be able to add to it.
    expect(reviewConsoleLines({ mode: "self", reports: [] })).toEqual(["SELF"]);
  });

  test("a report missing its content or its reason never prints the word undefined", () => {
    // Raised in review. Neither shape is reachable from runOne today; the
    // contract is parsed by other agents, and "undefined" in it is worse than
    // an unreachable branch.
    const malformed: ReviewRunResult = {
      mode: "external",
      reports: [
        { reviewerId: "a", label: "A", model: "m", ok: true },
        { reviewerId: "b", label: "B", model: "m", ok: false },
      ],
    };

    const lines = reviewConsoleLines(malformed);

    expect(lines.join("\n")).not.toContain("undefined");
    expect(lines[0]).toContain("(reported nothing)");
    expect(lines[1]).toContain("no reason given");
  });

  test("a reported review prints each report, available or not", () => {
    const lines = reviewConsoleLines(twoReviewers);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[Codex (gpt-5.6-sol)] unavailable: usage limit");
    expect(lines[1]).toContain("===== DeepSeek (deepseek-v4-pro) =====");
    expect(lines[1]).toContain("No defects found.");
  });
});

describe("names", () => {
  test("a branch with slashes becomes one directory", () => {
    expect(branchSlug("feat/error-stream-watch")).toBe("feat-error-stream-watch");
    expect(branchSlug("")).toBe("detached");
  });

  test("the directory sorts by time and says which branch", () => {
    expect(runDirName(meta())).toBe("2026-08-05T16-30-00-feat-error-stream-watch");
  });
});

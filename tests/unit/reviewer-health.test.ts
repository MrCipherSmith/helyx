/**
 * Whether a reviewer can review, asked without being asked.
 *
 * Three failures of one thing, all live on 2026-08-05: the question was wrong
 * (`codex login status` answered "logged in" for six days while every run was
 * refused), nobody asked it on a schedule, and the failure was misfiled —
 * Codex says "usage limit" and the classifier only knew "rate limit".
 *
 * These drive the real `lastOutcomeByReviewer` against real files, and the real
 * `checkReviewerHealth` against scripted statuses.
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastOutcomeByReviewer } from "../../services/review-artifacts.ts";
import { failureHidesFromProbe } from "../../services/reviewer-service.ts";
import {
  checkReviewerHealth,
  resetReviewerHealthState,
  balanceBelowFloor,
  balanceRearmed,
  type ReviewerHealthDeps,
} from "../../scripts/supervisor.ts";
import type { ReviewerStatus } from "../../services/reviewer-service.ts";

const dirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "helyx-rh-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeRun(root: string, name: string, ageMin: number, reports: unknown[]): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "run.json");
  writeFileSync(path, JSON.stringify({ version: 1, startedAt: "2026-08-05T16:00:00.000Z", reports }));
  const when = new Date(Date.now() - ageMin * 60_000);
  utimesSync(path, when, when);
}

describe("what the last run says", () => {
  test("the newest artifact answers, per reviewer", async () => {
    const root = tempRoot();
    writeRun(root, "2026-08-05T10-00-00-main", 120, [
      { reviewerId: "codex", ok: true, error: null },
    ]);
    writeRun(root, "2026-08-05T16-00-00-main", 1, [
      { reviewerId: "codex", ok: false, error: "limit until aug 11th, 2026" },
      { reviewerId: "provider:4", ok: true, error: null },
    ]);

    const outcomes = await lastOutcomeByReviewer(root);

    // The older run said Codex was fine. It has since been superseded, and
    // merging the two would invent a history nobody recorded.
    expect(outcomes.get("codex")).toMatchObject({ ok: false, error: "limit until aug 11th, 2026" });
    expect(outcomes.get("provider:4")).toMatchObject({ ok: true });
  });

  test("a reviewer the newest run does not mention keeps its last evidence", async () => {
    // Raised in review: reading only the newest artifact meant that if Codex
    // failed on a quota and DeepSeek then ran alone, Codex's evidence vanished
    // and the login probe put a green tick back on it. Silence about a
    // reviewer is not news about it.
    const root = tempRoot();
    writeRun(root, "2026-08-05T10-00-00-main", 120, [
      { reviewerId: "codex", ok: false, error: "limit until aug 11th, 2026" },
      { reviewerId: "provider:4", ok: true, error: null },
    ]);
    writeRun(root, "2026-08-05T16-00-00-main", 1, [
      { reviewerId: "provider:4", ok: true, error: null },
    ]);

    const outcomes = await lastOutcomeByReviewer(root);

    expect(outcomes.get("codex")).toMatchObject({ ok: false, error: "limit until aug 11th, 2026" });
    expect(outcomes.get("provider:4")).toMatchObject({ ok: true });
  });

  test("an unreadable newest record does not stop the search", async () => {
    const root = tempRoot();
    writeRun(root, "2026-08-05T10-00-00-main", 120, [{ reviewerId: "codex", ok: false, error: "auth" }]);
    const broken = join(root, "2026-08-05T16-00-00-main");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "run.json"), "{ not json");

    expect((await lastOutcomeByReviewer(root)).get("codex")).toMatchObject({ ok: false, error: "auth" });
  });

  test("no artifacts is an empty answer, not a failure", async () => {
    expect(await lastOutcomeByReviewer(tempRoot())).toEqual(new Map());
    expect(await lastOutcomeByReviewer(join(tempRoot(), "never-made"))).toEqual(new Map());
  });

  test("an unreadable record is skipped rather than thrown", async () => {
    const root = tempRoot();
    const dir = join(root, "2026-08-05T16-00-00-main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), "{ not json");

    expect(await lastOutcomeByReviewer(root)).toEqual(new Map());
  });
});

describe("which recorded failures may override a live probe", () => {
  test("the ones a probe reports as healthy", () => {
    // The six-day case: logged in, and refused on every run.
    expect(failureHidesFromProbe("limit until aug 11th, 2026 5:49 pm")).toBe(true);
    expect(failureHidesFromProbe("auth")).toBe(true);
    expect(failureHidesFromProbe("model-unsupported: this account cannot use the configured model")).toBe(true);
    expect(failureHidesFromProbe("cli-usage: the codex invocation is wrong for this CLI version")).toBe(true);
  });

  test("and not the ones it cannot", () => {
    // Raised in review: overriding on any failure means one flaky timeout
    // marks a reviewer down until somebody happens to run a successful review.
    // The distinction is kind, not recency — a spent quota is still true a week
    // later.
    expect(failureHidesFromProbe("failed (exit 1)")).toBe(false);
    expect(failureHidesFromProbe("empty output")).toBe(false);
    expect(failureHidesFromProbe("fetch failed")).toBe(false);
    expect(failureHidesFromProbe(null)).toBe(false);
  });
});

describe("balanceBelowFloor", () => {
  test("reads the balance the probe reported", () => {
    expect(balanceBelowFloor("balance $0.31")).toBe(true);
    expect(balanceBelowFloor("balance $7.43")).toBe(false);
    // No balance in the detail is not a low balance.
    expect(balanceBelowFloor("logged in")).toBe(false);
  });
});

describe("balanceRearmed", () => {
  test("a missing number is unknown, not resolved", () => {
    // `balance check failed` is what a thrown probe reports. Treating it as a
    // recovery announced one on the strength of knowing nothing.
    expect(balanceRearmed("balance check failed")).toBe(false);
    expect(balanceRearmed("balance $2.10")).toBe(false); // floor 2 + margin 1
    expect(balanceRearmed("balance $3.50")).toBe(true);
  });
});

describe("checkReviewerHealth", () => {
  let alerts: Array<{ text: string; key: string }>;
  let clears: Array<{ text: string; key: string }>;

  const deps = (statuses: ReviewerStatus[]): ReviewerHealthDeps => ({
    statuses: async () => statuses,
    alert: async (text, key) => { alerts.push({ text, key }); },
    clear: async (text, key) => { clears.push({ text, key }); },
  });

  const status = (over: Partial<ReviewerStatus> = {}): ReviewerStatus => ({
    id: "codex",
    label: "Codex",
    model: "gpt-5.6-sol",
    available: true,
    probed: true,
    detail: "logged in",
    ...over,
  });

  beforeEach(() => {
    alerts = [];
    clears = [];
    resetReviewerHealthState();
  });

  test("a reviewer that goes down alerts once, and not again while it stays down", async () => {
    await checkReviewerHealth(deps([status()]));
    await checkReviewerHealth(deps([status({ available: false, detail: "limit until aug 11th, 2026" })]));
    await checkReviewerHealth(deps([status({ available: false, detail: "limit until aug 11th, 2026" })]));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.key).toBe("reviewer_down:codex");
    expect(alerts[0]!.text).toContain("limit until aug 11th");
  });

  test("a recovery clears once", async () => {
    await checkReviewerHealth(deps([status()]));
    await checkReviewerHealth(deps([status({ available: false, detail: "limit" })]));
    await checkReviewerHealth(deps([status()]));
    await checkReviewerHealth(deps([status()]));

    expect(clears).toHaveLength(1);
    expect(clears[0]!.text).toContain("снова доступен");
  });

  test("a reviewer already down on the first pass is said once", async () => {
    // Otherwise a daemon restart during an outage is silent about it.
    await checkReviewerHealth(deps([status({ available: false, detail: "limit" })]));
    await checkReviewerHealth(deps([status({ available: false, detail: "limit" })]));

    expect(alerts).toHaveLength(1);
  });

  test("a reviewer that was up and stays up says nothing", async () => {
    await checkReviewerHealth(deps([status()]));
    await checkReviewerHealth(deps([status()]));

    expect(alerts).toEqual([]);
    expect(clears).toEqual([]);
  });

  test("an unprobed reviewer is not evidence in either direction", async () => {
    await checkReviewerHealth(deps([status({ probed: false, available: false, detail: "не проверялся" })]));
    await checkReviewerHealth(deps([status({ probed: false, available: true, detail: "не проверялся" })]));

    expect(alerts).toEqual([]);
    expect(clears).toEqual([]);
  });

  test("a balance under the floor is down even when the endpoint answered", async () => {
    const provider = status({ id: "provider:4", label: "DeepSeek", available: true, detail: "balance $7.43" });

    await checkReviewerHealth(deps([provider]));
    await checkReviewerHealth(deps([{ ...provider, detail: "balance $0.31" }]));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("balance $0.31");
  });

  test("a balance hovering at the line does not alternate", async () => {
    // Floor 2, margin 1: crossing down at 1.90 alerts, and coming back to 2.10
    // is not yet enough to re-arm — otherwise every top-up of a few cents
    // produces a pair of messages.
    const provider = status({ id: "provider:4", label: "DeepSeek", detail: "balance $7.00" });

    await checkReviewerHealth(deps([provider]));
    await checkReviewerHealth(deps([{ ...provider, detail: "balance $1.90" }]));
    await checkReviewerHealth(deps([{ ...provider, detail: "balance $2.10" }]));

    expect(alerts).toHaveLength(1);
    expect(clears).toEqual([]);

    await checkReviewerHealth(deps([{ ...provider, detail: "balance $3.50" }]));

    expect(clears).toHaveLength(1);
  });

  test("a failed balance check does not clear a low-balance alert", async () => {
    // The false clear: no number means unknown, and a recovery message on the
    // strength of knowing nothing is worse than silence.
    const provider = status({ id: "provider:4", label: "DeepSeek", detail: "balance $7.00" });

    await checkReviewerHealth(deps([provider]));
    await checkReviewerHealth(deps([{ ...provider, detail: "balance $0.31" }]));
    await checkReviewerHealth(deps([{ ...provider, detail: "balance check failed" }]));

    expect(alerts).toHaveLength(1);
    expect(clears).toEqual([]);
  });

  test("a reviewer down for a reason other than balance clears without one", async () => {
    // Codex has no balance to report; requiring one would leave it down for ever.
    await checkReviewerHealth(deps([status()]));
    await checkReviewerHealth(deps([status({ available: false, detail: "limit until aug 11th" })]));
    await checkReviewerHealth(deps([status({ detail: "logged in" })]));

    expect(clears).toHaveLength(1);
  });

  test("a probe that throws is not an outage", async () => {
    // The supervisor cannot tell the difference between "the reviewer is down"
    // and "we could not ask", and only one of those is worth waking someone up.
    await checkReviewerHealth({
      statuses: async () => { throw new Error("network"); },
      alert: async (text, key) => { alerts.push({ text, key }); },
      clear: async (text, key) => { clears.push({ text, key }); },
    });

    expect(alerts).toEqual([]);
  });
});

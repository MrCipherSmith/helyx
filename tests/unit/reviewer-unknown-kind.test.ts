/**
 * A reviewer this build does not understand, named as that.
 *
 * The reviewer set is JSON in `bot_config`: one build writes it, whichever
 * build is running reads it. So a kind the running code has never heard of is
 * an ordinary consequence of a rollback, not a corruption — and it happened. A
 * checkout from before flow #056 read a stored `kind: "claude"`, fell through
 * the two-test dispatch into the provider path, looked up `providers.id =
 * undefined` and reported `[provider#undefined] unavailable: unknown provider`.
 * Every word of that was wrong: the providers table was fine and the reviewer
 * was never a provider reviewer. The operator who read it went looking for a
 * broken row that did not exist.
 *
 * These pin both halves — the run path and the status path — and that a
 * genuinely missing provider row still says so.
 */

import { describe, test, expect } from "bun:test";
import {
  runSingleReviewer,
  callProviderReview,
  unhandledKind,
  unknownKindStatus,
  unknownKindDetail,
  type Reviewer,
} from "../../services/reviewer-service.ts";

/** A stored row from a build that knew a kind this one does not. */
function fromTheFuture(kind: string): Reviewer {
  return { id: `${kind}:1`, kind: kind as Reviewer["kind"], model: "some-model-9", enabled: true };
}

const NO_DIFF = async () => "diff --git a/x b/x\n";

describe("an unrecognised reviewer kind", () => {
  test("fails as itself rather than as a provider", async () => {
    const report = await runSingleReviewer(fromTheFuture("mystery"), "review this", NO_DIFF);

    expect(report.ok).toBe(false);
    expect(report.error).toBe("unknown reviewer kind: mystery");
    // The old fallthrough's answer — it must not be able to say this any more.
    expect(report.error).not.toContain("unknown provider");
    expect(report.label).not.toContain("provider#");
  });

  test("keeps the reviewer's own id and model, so the report is attributable", async () => {
    const report = await runSingleReviewer(fromTheFuture("gemini"), "review this", NO_DIFF);

    expect(report.reviewerId).toBe("gemini:1");
    expect(report.label).toBe("gemini:1");
    expect(report.model).toBe("some-model-9");
  });

  test("reads as unavailable in the status list, blaming the kind and not the providers table", () => {
    const status = unknownKindStatus(fromTheFuture("mystery"));

    expect(status).toEqual({
      id: "mystery:1",
      label: "mystery:1",
      model: "some-model-9",
      available: false,
      // Asked and answered: nothing in this build can run it. Not "nobody asked".
      probed: true,
      detail: "unknown reviewer kind: mystery",
    });
  });

  test("the run path and the status path give the same reason", () => {
    const reviewer = fromTheFuture("mystery");
    const report = unhandledKind(reviewer.kind as never, reviewer);

    expect(report.error).toBe(unknownKindStatus(reviewer).detail);
    expect(report.error).toBe(unknownKindDetail("mystery"));
  });
});

describe("a provider reviewer with no provider row", () => {
  test("still says unknown provider — the new branch does not swallow it", async () => {
    const orphan: Reviewer = { id: "provider:404", kind: "provider", providerId: 404, model: "m", enabled: true };
    const report = await callProviderReview(orphan, "prompt", fetch, async () => null);

    expect(report.ok).toBe(false);
    expect(report.error).toBe("unknown provider");
    expect(report.label).toBe("provider#404");
  });
});

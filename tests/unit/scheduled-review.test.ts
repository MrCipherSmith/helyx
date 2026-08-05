/**
 * The review that starts itself.
 *
 * Nothing did: `scripts/review.ts` ran when a person typed it, and the moment a
 * review is most valuable — a branch that has stopped changing — is exactly the
 * moment attention has moved on.
 *
 * The decision is pure and is tested as a table. The loop around it is tested
 * for the two things a loop gets wrong: what it remembers between passes, and
 * what it does when the work fails.
 */

import { describe, test, expect } from "bun:test";
import {
  scheduledReviewDecision,
  REVIEW_STALE_AFTER_MS,
  type ScheduledReviewState,
} from "../../services/review-artifacts.ts";
import { maybeRunScheduledReview, diffHash, type ScheduledReviewDeps } from "../../scripts/supervisor.ts";

const NOW = 1_700_000_000_000;

const decide = (over: {
  branch?: string;
  diffHash?: string;
  state?: ScheduledReviewState;
  now?: number;
} = {}) =>
  scheduledReviewDecision({
    branch: over.branch ?? "feat/x",
    defaultBranch: "main",
    diffHash: over.diffHash ?? "abc",
    state: over.state ?? { lastSeenHash: "abc" },
    now: over.now ?? NOW,
  });

describe("when a review starts itself", () => {
  test("a hash seen twice in a row and never reviewed", () => {
    expect(decide()).toEqual({ run: true, reason: "settled" });
  });

  test("never on the default branch", () => {
    // A merge has already happened; reviewing it is archaeology.
    expect(decide({ branch: "main" }).reason).toBe("default-branch");
    expect(decide({ branch: "" }).reason).toBe("default-branch");
  });

  test("never on an empty diff", () => {
    expect(decide({ diffHash: "" }).reason).toBe("empty-diff");
  });

  test("not while the branch is still being written", () => {
    // First sighting of a hash: the branch changed since the last pass, so it
    // has not settled.
    expect(decide({ state: { lastSeenHash: "older" } }).reason).toBe("still-changing");
    expect(decide({ state: {} }).reason).toBe("still-changing");
  });

  test("not twice for the same content", () => {
    expect(decide({ state: { lastSeenHash: "abc", lastReviewedHash: "abc" } }).reason).toBe("already-reviewed");
  });

  test("not while another review is in flight — refused, not queued", () => {
    // By the time the running one finishes, this one's diff is probably stale.
    expect(
      decide({ state: { lastSeenHash: "abc", running: true, runningSince: NOW - 60_000 } }).reason,
    ).toBe("review-in-flight");
  });

  test("a flag left behind by a dead process does not disable the loop for ever", () => {
    // Raised in review: a process killed between setting the flag and clearing
    // it left `running: true` in the database, and the loop then refused to run
    // again — a feature disabled permanently by one crash.
    expect(
      decide({
        state: { lastSeenHash: "abc", running: true, runningSince: NOW - REVIEW_STALE_AFTER_MS - 1 },
      }),
    ).toEqual({ run: true, reason: "settled" });

    // A flag with no timestamp at all is from before this was recorded, and is
    // likewise not allowed to be permanent.
    expect(decide({ state: { lastSeenHash: "abc", running: true } }).run).toBe(true);
  });

  test("a changed diff after a reviewed one is reviewed once it settles", () => {
    const state: ScheduledReviewState = { lastSeenHash: "abc", lastReviewedHash: "abc" };

    // New content arrives: seen for the first time, so not yet.
    expect(decide({ diffHash: "def", state }).reason).toBe("still-changing");
    // Same content next pass: settled.
    expect(decide({ diffHash: "def", state: { ...state, lastSeenHash: "def" } })).toEqual({
      run: true,
      reason: "settled",
    });
  });
});

describe("diffHash", () => {
  test("empty for an empty diff, stable otherwise", () => {
    expect(diffHash("")).toBe("");
    expect(diffHash("   \n ")).toBe("");
    expect(diffHash("diff --git a b")).toBe(diffHash("diff --git a b"));
    expect(diffHash("diff --git a b")).not.toBe(diffHash("diff --git a c"));
  });
});

describe("the loop around the decision", () => {
  interface Harness {
    deps: ScheduledReviewDeps;
    saved: ScheduledReviewState[];
    posts: string[];
    notes: string[];
    reviews: string[];
  }

  function harness(over: {
    branch?: string;
    diff?: string;
    state?: ScheduledReviewState;
    fail?: boolean;
  } = {}): Harness {
    const saved: ScheduledReviewState[] = [];
    const posts: string[] = [];
    const notes: string[] = [];
    const reviews: string[] = [];
    let state = over.state ?? {};

    return {
      saved,
      posts,
      notes,
      reviews,
      deps: {
        branch: async () => over.branch ?? "feat/x",
        diff: async () => over.diff ?? "diff --git a b",
        loadState: async () => state,
        saveState: async (next) => { state = next; saved.push(next); },
        runReview: async (prompt) => {
          reviews.push(prompt);
          if (over.fail) throw new Error("reviewer exploded");
          return { artifactDir: "logs/reviews/x", summary: "1 из 2 ревьюеров ответили" };
        },
        note: (m) => { notes.push(m); },
        post: async (t) => { posts.push(t); },
      },
    };
  }

  test("a first sighting reviews nothing and remembers the hash", async () => {
    const h = harness();

    await maybeRunScheduledReview(h.deps);

    expect(h.reviews).toEqual([]);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.lastSeenHash).toBe(diffHash("diff --git a b"));
    expect(h.saved[0]!.lastReviewedHash).toBeUndefined();
  });

  test("the second sighting reviews, records the hash and posts once", async () => {
    const hash = diffHash("diff --git a b");
    const h = harness({ state: { lastSeenHash: hash } });

    await maybeRunScheduledReview(h.deps);

    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]).toContain("feat/x");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain("feat/x");
    expect(h.posts[0]).toContain("logs/reviews/x");
    // Running is set before and cleared after, and the reviewed hash is stored
    // so the next pass says "already-reviewed".
    expect(h.saved[0]!.running).toBe(true);
    expect(h.saved.at(-1)).toMatchObject({ lastReviewedHash: hash, running: false });
  });

  test("a failed review clears the in-flight flag, or the loop never runs again", async () => {
    const hash = diffHash("diff --git a b");
    const h = harness({ state: { lastSeenHash: hash }, fail: true });

    await maybeRunScheduledReview(h.deps);

    expect(h.saved.at(-1)!.running).toBe(false);
    // And the hash is not recorded as reviewed: it was not.
    expect(h.saved.at(-1)!.lastReviewedHash).toBeUndefined();
    expect(h.notes[0]).toContain("reviewer exploded");
    expect(h.posts).toEqual([]);
  });

  test("a failed post does not throw away a review that happened", async () => {
    // Raised in review: rolling the state back when the announcement failed
    // discarded a review that had actually run, and the same diff was then
    // reviewed again on the next pass.
    const hash = diffHash("diff --git a b");
    const saved: ScheduledReviewState[] = [];
    const notes: string[] = [];
    let state: ScheduledReviewState = { lastSeenHash: hash };

    await maybeRunScheduledReview({
      branch: async () => "feat/x",
      diff: async () => "diff --git a b",
      loadState: async () => state,
      saveState: async (next) => { state = next; saved.push(next); },
      runReview: async () => ({ artifactDir: "logs/reviews/x", summary: "ok" }),
      note: (m) => { notes.push(m); },
      post: async () => { throw new Error("telegram is down"); },
    });

    expect(saved.at(-1)).toMatchObject({ lastReviewedHash: hash, running: false });
    expect(notes[0]).toContain("telegram is down");
  });

  test("a branch that cannot be read is a note, not a crash", async () => {
    const posts: string[] = [];
    const notes: string[] = [];

    await maybeRunScheduledReview({
      branch: async () => { throw new Error("not a git repository"); },
      diff: async () => "",
      loadState: async () => ({}),
      saveState: async () => {},
      runReview: async () => ({ artifactDir: null, summary: "" }),
      note: (m) => { notes.push(m); },
      post: async (t) => { posts.push(t); },
    });

    expect(notes[0]).toContain("not a git repository");
    expect(posts).toEqual([]);
  });

  test("the default branch is never reviewed and writes no state churn", async () => {
    const hash = diffHash("diff --git a b");
    const h = harness({ branch: "main", state: { lastSeenHash: hash } });

    await maybeRunScheduledReview(h.deps);

    expect(h.reviews).toEqual([]);
    // The hash is already what it was: nothing to write.
    expect(h.saved).toEqual([]);
  });
});

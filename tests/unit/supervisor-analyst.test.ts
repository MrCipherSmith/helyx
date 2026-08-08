/**
 * What the health analyst is shown, and what happens when it does not answer.
 *
 * `formatSnapshotForGemma` is the only thing standing between a system snapshot
 * and a model's judgement of it: a section quietly dropped is a problem the
 * analyst is structurally unable to see, which is the same defect as a container
 * list that cannot contain a dead container.
 *
 * `callGemmaForHealth` and `getLlmExplanation` both call out over the network
 * from inside a loop. Neither may throw: an analyst that crashes the loop it
 * runs in is worse than one that says nothing.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  formatSnapshotForGemma,
  callGemmaForHealth,
  getLlmExplanation,
  type SystemSnapshot,
} from "../../scripts/supervisor.ts";

const empty: SystemSnapshot = {
  activeSessions: [],
  stuckStatusMessages: [],
  pendingQueueItems: [],
  processHealth: [],
  tmuxSessions: "no sessions",
  dockerContainers: "no containers",
};

const busy: SystemSnapshot = {
  activeSessions: [{ project: "helyx", lastActiveAgo: "2m ago" }],
  stuckStatusMessages: [{ project: "keryx", stuckMin: 12 }],
  pendingQueueItems: [{ project: "goodai", oldestAgo: "8m" }],
  processHealth: [{ name: "supervisor", status: "running" }],
  tmuxSessions: "bots: 10 windows",
  dockerContainers: "helyx-bot-1\tUp 2 hours (healthy)\nhelyx-postgres-1\tExited (1)",
};

describe("the snapshot the analyst reads", () => {
  test("every section is present even when it is empty", () => {
    // A section that disappears when its list is empty is a section the model
    // cannot ask about. The absence has to be stated.
    const text = formatSnapshotForGemma(empty);

    expect(text).toContain("Active sessions (0):");
    expect(text).toContain("Stuck status messages");
    expect(text).toContain("Pending queue items");
    expect(text).toContain("Process health:");
    expect(text).toContain("tmux sessions:");
    expect(text).toContain("Docker containers:");
    expect(text.match(/ {2}none/g)).toHaveLength(3);
    expect(text).toContain("  no data");
  });

  test("a populated snapshot carries each fact the analyst is asked to judge", () => {
    const text = formatSnapshotForGemma(busy);

    expect(text).toContain("Active sessions (1):");
    expect(text).toContain("helyx: last active 2m ago");
    expect(text).toContain("keryx: stuck 12 min");
    expect(text).toContain("goodai: oldest 8m");
    expect(text).toContain("supervisor: running");
    // The dead container has to survive the rendering: it is the single fact
    // most worth the analyst noticing.
    expect(text).toContain("Exited (1)");
  });

  test("multi-line blocks stay indented under their heading", () => {
    // Otherwise a container name starts a line at column zero and reads to the
    // model as a new section.
    const text = formatSnapshotForGemma(busy);

    expect(text).toContain("Docker containers:\n  helyx-bot-1");
    expect(text).toContain("\n  helyx-postgres-1");
  });
});

describe("when the model does not answer", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const stub = (impl: () => Response | never) => {
    globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
  };

  test("a refused request is a healthy verdict, not a thrown error", async () => {
    // The loop that calls this is scheduled with `.catch(() => {})`; a throw
    // here would be swallowed and the analyst would simply stop running.
    stub(() => new Response("nope", { status: 503 }));

    await expect(callGemmaForHealth("snapshot")).resolves.toEqual({ ok: true, digest: "", asked: false });
  });

  test("a network failure is the same", async () => {
    stub(() => { throw new Error("ECONNREFUSED"); });

    await expect(callGemmaForHealth("snapshot")).resolves.toEqual({ ok: true, digest: "", asked: false });
  });

  test("an unparseable body is the same", async () => {
    stub(() => new Response("<html>gateway</html>", { status: 200 }));

    await expect(callGemmaForHealth("snapshot")).resolves.toEqual({ ok: true, digest: "", asked: false });
  });

  test("OK means healthy, and anything else is carried through as the digest", async () => {
    stub(() => Response.json({ message: { content: "OK" } }));
    await expect(callGemmaForHealth("snapshot")).resolves.toEqual({ ok: true, digest: "", asked: true });

    stub(() => Response.json({ message: { content: "Очередь стоит 12 минут" } }));
    const verdict = await callGemmaForHealth("snapshot");

    expect(verdict.ok).toBe(false);
    expect(verdict.digest).toContain("Очередь стоит 12 минут");
    expect(verdict.asked).toBe(true);
  });

  test("a clean verdict and an unanswered one are not the same value", async () => {
    // They were, and that is the bug: the analyst runs every 10 minutes against
    // a 5-minute keep_alive, so it is normally cold, and a cold load outlasts
    // this call's 15s ceiling. Every timeout used to be filed as health.
    stub(() => Response.json({ message: { content: "OK" } }));
    const clean = await callGemmaForHealth("snapshot");

    stub(() => { throw new Error("timed out"); });
    const silent = await callGemmaForHealth("snapshot");

    expect(clean.ok).toBe(true);
    expect(silent.ok).toBe(true);
    expect(clean.asked).not.toBe(silent.asked);
  });

  test("a reached model that answers with nothing has not answered", async () => {
    stub(() => Response.json({ message: { content: "   " } }));

    await expect(callGemmaForHealth("snapshot")).resolves.toEqual({ ok: true, digest: "", asked: false });
  });

  test("the incident explanation degrades to empty rather than failing the alert", async () => {
    // It runs while an alert is being assembled. An alert that fails to send
    // because its explanatory sentence could not be fetched is a worse outcome
    // than an alert with no sentence.
    stub(() => { throw new Error("ECONNREFUSED"); });

    await expect(getLlmExplanation("hung", "helyx", 300, "restart", "pending")).resolves.toBe("");
  });

  test("an explanation that arrives is returned", async () => {
    stub(() => Response.json({ message: { content: "Сессия не отвечала пять минут." } }));

    await expect(getLlmExplanation("hung", "helyx", 300, "restart", "pending")).resolves.toContain(
      "Сессия не отвечала",
    );
  });
});

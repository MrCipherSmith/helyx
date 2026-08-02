import { describe, test, expect } from "bun:test";
import {
  classifyContainer,
  classifySession,
  summarizeQueue,
  hasProblems,
} from "../../utils/supervisor-status.ts";

/**
 * The 5-minute status broadcast decides whether the operator is notified or
 * whether a message is quietly edited under them. Until now none of its four
 * decisions was tested, and one of them could not reach its failing state at
 * all: the container check was a blacklist against `exited` and `dead`, run
 * over the output of `docker ps` — which never lists either.
 */

describe("classifyContainer — healthy", () => {
  test.each([
    "Up 3 days",
    "Up 16 hours (healthy)",
    "Up 2 days",
    "Up 2 minutes",
  ])("%s is healthy", (status) => {
    expect(classifyContainer(status).healthy).toBe(true);
  });

  test("surrounding whitespace does not change the answer", () => {
    expect(classifyContainer("  Up 3 days (healthy)  ").healthy).toBe(true);
  });
});

describe("classifyContainer — the states the blacklist could not see", () => {
  test("a crash loop is not healthy", () => {
    // `docker ps` lists restarting containers. The old check saw "Restarting",
    // found neither "exited" nor "dead" at the start, and painted it green.
    const c = classifyContainer("Restarting (1) 5 seconds ago");
    expect(c.healthy).toBe(false);
    expect(c.reason).toBe("Restarting");
  });

  test("a failing healthcheck is not healthy", () => {
    const c = classifyContainer("Up 2 minutes (unhealthy)");
    expect(c.healthy).toBe(false);
    expect(c.reason).toBe("unhealthy");
  });

  test("a paused container is not healthy", () => {
    const c = classifyContainer("Up 3 days (Paused)");
    expect(c.healthy).toBe(false);
    expect(c.reason).toBe("paused");
  });
});

describe("classifyContainer — states that only `docker ps -a` shows", () => {
  test.each(["Exited (0) 5 minutes ago", "Exited (137) 2 hours ago", "Created", "Dead"])(
    "%s is not healthy",
    (status) => {
      expect(classifyContainer(status).healthy).toBe(false);
    },
  );
});

describe("classifyContainer — it is an allowlist", () => {
  test("an unrecognised status reads as a problem, not as fine", () => {
    // The point of inverting the check: a state docker adds later, or one
    // nobody anticipated, should make someone look rather than pass silently.
    expect(classifyContainer("Removing").healthy).toBe(false);
    expect(classifyContainer("Something entirely new").healthy).toBe(false);
    expect(classifyContainer("").healthy).toBe(false);
  });

  test("only a leading Up qualifies — the word appearing later does not", () => {
    expect(classifyContainer("Restarting (1) — was Up 3 days").healthy).toBe(false);
  });
});

describe("classifySession", () => {
  const T = 1_700_000_000_000;
  const base = { asmUpdatedMs: null, pendingMsgs: 0, lastActiveMs: null, now: T };

  test("a fresh heartbeat means working, with the age shown", () => {
    const s = classifySession({ ...base, asmUpdatedMs: T - 30_000 });
    expect(s.icon).toBe("🔄");
    expect(s.text).toBe("работает (heartbeat 30s назад)");
  });

  test("a heartbeat older than two minutes is not fresh", () => {
    const s = classifySession({ ...base, asmUpdatedMs: T - 2 * 60 * 1000, lastActiveMs: T - 3600_000 });
    expect(s.icon).not.toBe("🔄");
  });

  test("a fresh heartbeat wins over queued messages", () => {
    // Load-bearing branch order: a session that is working AND has a queue
    // reports working and says nothing about the queue. That is intended —
    // the queue is not stuck while Claude is mid-turn, and the queue summary
    // below the session list still counts it — but it reads like an
    // oversight, so it is pinned here.
    const s = classifySession({ ...base, asmUpdatedMs: T - 1000, pendingMsgs: 7 });
    expect(s.icon).toBe("🔄");
    expect(s.text).not.toContain("очереди");
  });

  test("queued messages win over recent activity", () => {
    const s = classifySession({ ...base, pendingMsgs: 3, lastActiveMs: T - 1000 });
    expect(s.icon).toBe("📨");
    expect(s.text).toBe("3 сообщ. в очереди");
  });

  test("recent activity reads as just now", () => {
    const s = classifySession({ ...base, lastActiveMs: T - 30_000 });
    expect(s).toEqual({ icon: "🟢", text: "активна только что" });
  });

  test("a minute of silence is already idle", () => {
    const s = classifySession({ ...base, lastActiveMs: T - 60_000 });
    expect(s.icon).toBe("⚪");
    expect(s.text).toBe("ожидание (idle 1m)");
  });

  test("idle under an hour is shown in minutes, over an hour in hours", () => {
    expect(classifySession({ ...base, lastActiveMs: T - 45 * 60_000 }).text)
      .toBe("ожидание (idle 45m)");
    expect(classifySession({ ...base, lastActiveMs: T - 3 * 3600_000 }).text)
      .toBe("ожидание (idle 3h)");
  });

  test("an unknown last-active shows a question mark rather than a number", () => {
    expect(classifySession(base).text).toBe("ожидание (idle ?)");
  });
});

describe("summarizeQueue", () => {
  test("stuck messages take precedence and both counts are shown", () => {
    expect(summarizeQueue(12, 3)).toBe("⚠️ 12 pending, 3 зависших");
  });

  test("pending but nothing stuck", () => {
    expect(summarizeQueue(4, 0)).toBe("📨 4 pending");
  });

  test("an empty queue", () => {
    expect(summarizeQueue(0, 0)).toBe("✅ очередь пуста");
  });

  test("stuck without pending still reports stuck", () => {
    // Should not happen — stuck is a subset of pending — but the branch order
    // means the answer is defined rather than accidental.
    expect(summarizeQueue(0, 2)).toBe("⚠️ 0 pending, 2 зависших");
  });
});

describe("hasProblems", () => {
  const ok = { healthy: true };
  const bad = { healthy: false, reason: "unhealthy" };

  test("all healthy and an empty queue means no problems", () => {
    expect(hasProblems({ containers: [ok, ok], stuckTotal: 0 })).toBe(false);
  });

  test("a stuck queue is a problem", () => {
    expect(hasProblems({ containers: [ok], stuckTotal: 1 })).toBe(true);
  });

  test("one unhealthy container is a problem", () => {
    // The half of the condition that could never fire before: a crash-looping
    // container was painted green, and the notification never went out.
    expect(hasProblems({ containers: [ok, bad, ok], stuckTotal: 0 })).toBe(true);
  });

  test("no containers at all is not a problem by itself", () => {
    expect(hasProblems({ containers: [], stuckTotal: 0 })).toBe(false);
  });

  test("it reads state, not rendered text", () => {
    // The version this replaced grepped the rendered lines for a leading 🔴,
    // which made the choice of icon part of the alerting logic.
    expect(hasProblems({ containers: [{ healthy: false }], stuckTotal: 0 })).toBe(true);
  });
});

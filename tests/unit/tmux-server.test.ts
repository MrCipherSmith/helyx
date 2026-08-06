/**
 * The judgements that decide whether a restart worked.
 *
 * These exist because the failure they guard against cannot be reproduced
 * safely: it needs a live tmux server with the `bots` session gone, which is
 * the outage itself. So the decision and the verdict were pulled out of the
 * shell and are tested here instead — see sessions/tmux-server.ts and
 * docs/restart-problem.md.
 */

import { describe, expect, test } from "bun:test";
import {
  decideTmuxScope,
  verifyStart,
  parseScopeState,
  summarizeTmuxHost,
  renderTmuxHealthLine,
  TMUX_SCOPE_UNIT,
} from "../../sessions/tmux-server.ts";

describe("decideTmuxScope", () => {
  const linux = { platform: "linux", hasSystemdRun: true };

  test("a running tmux server means no scope — the 2026-08-05 collision", () => {
    const d = decideTmuxScope({ ...linux, hasTmuxServer: true });
    expect(d.prefix).toEqual([]);
    expect(d.clearUnit).toBe(false);
  });

  test("no server means the scope, and the stale unit is cleared first", () => {
    const d = decideTmuxScope({ ...linux, hasTmuxServer: false });
    expect(d.prefix).toEqual([
      "systemd-run", "--user", "--scope", `--unit=${TMUX_SCOPE_UNIT}`, "--collect", "--quiet",
    ]);
    expect(d.clearUnit).toBe(true);
  });

  test("the unit is never cleared while a server is running — that would kill every session on it", () => {
    expect(decideTmuxScope({ ...linux, hasTmuxServer: true }).clearUnit).toBe(false);
  });

  test("no systemd-run, no scope", () => {
    const d = decideTmuxScope({ platform: "linux", hasSystemdRun: false, hasTmuxServer: false });
    expect(d.prefix).toEqual([]);
    expect(d.clearUnit).toBe(false);
  });

  test("darwin has no scopes to speak of", () => {
    const d = decideTmuxScope({ platform: "darwin", hasSystemdRun: true, hasTmuxServer: false });
    expect(d.prefix).toEqual([]);
    expect(d.clearUnit).toBe(false);
  });

  test("every decision carries a reason for the log", () => {
    for (const hasTmuxServer of [true, false]) {
      expect(decideTmuxScope({ ...linux, hasTmuxServer }).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("verifyStart", () => {
  const ok = (windows: string[]) => ({
    sessionExists: true,
    windows: new Set(windows),
    failed: [],
    expected: windows,
  });

  test("windows present and nothing failed is a pass", () => {
    const v = verifyStart(ok(["helyx", "keryx"]));
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
  });

  test("a run asked to start nothing is a pass — that is `helyx up` as a no-op", () => {
    const v = verifyStart({ sessionExists: true, windows: new Set(["helyx"]), failed: [], expected: [] });
    expect(v.ok).toBe(true);
  });

  test("no session is a failure however cheerful the steps were", () => {
    const v = verifyStart({
      sessionExists: false,
      windows: new Set(),
      failed: [],
      expected: ["helyx", "keryx"],
    });
    expect(v.ok).toBe(false);
    expect(v.summary).toContain("does not exist");
  });

  test("a session with zero windows is a failure — the exact shape of the outage", () => {
    const v = verifyStart({
      sessionExists: true,
      windows: new Set(),
      failed: [],
      expected: ["helyx"],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("no windows"))).toBe(true);
  });

  test("a failed window is reported with its error", () => {
    const v = verifyStart({
      sessionExists: true,
      windows: new Set(["helyx"]),
      failed: [{ window: "keryx", error: "tmux new-window failed" }],
      expected: ["helyx", "keryx"],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("keryx: tmux new-window failed"))).toBe(true);
  });

  test("a window that silently never appeared is caught even with no error to show", () => {
    const v = verifyStart({
      sessionExists: true,
      windows: new Set(["helyx"]),
      failed: [],
      expected: ["helyx", "keryx"],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("keryx"))).toBe(true);
  });

  test("a missing window is not reported twice when its failure is already known", () => {
    const v = verifyStart({
      sessionExists: true,
      windows: new Set(["helyx"]),
      failed: [{ window: "keryx", error: "boom" }],
      expected: ["helyx", "keryx"],
    });
    expect(v.problems.filter((p) => p.startsWith("keryx"))).toHaveLength(1);
  });
});

describe("parseScopeState", () => {
  test("reads the state systemctl prints", () => {
    expect(parseScopeState("active\n")).toBe("active");
    expect(parseScopeState("inactive")).toBe("inactive");
    expect(parseScopeState("failed\n")).toBe("failed");
  });

  test("no systemd to ask is not the same as inactive", () => {
    expect(parseScopeState("")).toBeNull();
    expect(parseScopeState("   \n")).toBeNull();
  });
});

describe("summarizeTmuxHost", () => {
  test("windows present is running", () => {
    const r = summarizeTmuxHost({ sessionExists: true, windowNames: ["helyx", "keryx"], scopeState: "active" });
    expect(r.status).toBe("running");
    expect(r.detail.windows).toBe(2);
  });

  test("a session with no windows is stopped, not running", () => {
    const r = summarizeTmuxHost({ sessionExists: true, windowNames: [], scopeState: "active" });
    expect(r.status).toBe("stopped");
  });

  test("no session at all is stopped", () => {
    expect(summarizeTmuxHost({ sessionExists: false, windowNames: [], scopeState: null }).status).toBe("stopped");
  });
});

describe("renderTmuxHealthLine", () => {
  test("a healthy session says how many windows", () => {
    expect(renderTmuxHealthLine({ session: true, windows: 10, scope: "active" })).toContain("10");
  });

  test("session present with zero windows is called out as its own state", () => {
    const line = renderTmuxHealthLine({ session: true, windows: 0, scope: "active" });
    expect(line).toContain("0");
    expect(line).toContain("⚠️");
  });

  test("no session plus an active scope names the collision the operator has to know about", () => {
    const line = renderTmuxHealthLine({ session: false, windows: 0, scope: "active" });
    expect(line).toContain("scope active");
  });

  test("no session without a scope does not invent one", () => {
    expect(renderTmuxHealthLine({ session: false, windows: 0, scope: "inactive" })).not.toContain("scope");
  });

  test("no data is said plainly rather than rendered as healthy", () => {
    expect(renderTmuxHealthLine(null)).toContain("нет данных");
  });
});

/**
 * The two halves, restarted by name.
 *
 * Both helpers take their shell, so what they run can be recorded without
 * running it — which is the only way to assert on commands that would restart
 * the machine this suite is running on.
 */

import { describe, expect, test } from "bun:test";
import { restartHostHalf } from "../../scripts/restart-host.ts";
import { restartDockerHalf } from "../../scripts/restart-docker.ts";

function recorder(results: Record<string, { ok: boolean; output: string }> = {}) {
  const calls: string[] = [];
  const run = async (cmd: string) => {
    calls.push(cmd);
    for (const [needle, result] of Object.entries(results)) {
      if (cmd.includes(needle)) return result;
    }
    return { ok: true, output: "" };
  };
  return { calls, run };
}

const HOST_OPTS = { botDir: "/app", bunBin: "/usr/bin/bun", cli: "/app/cli.ts" };

describe("restartHostHalf", () => {
  test("bounces the sessions", async () => {
    const { calls, run } = recorder();
    const r = await restartHostHalf(run, HOST_OPTS);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("bounce");
  });

  test("leaves the admin daemon alone unless asked — it is the step that kills the caller", async () => {
    const { calls, run } = recorder();
    await restartHostHalf(run, HOST_OPTS);
    expect(calls.some((c) => c.includes("helyx-admin"))).toBe(false);
  });

  test("restarts the daemon last, and only last", async () => {
    const { calls, run } = recorder();
    const r = await restartHostHalf(run, { ...HOST_OPTS, restartAdminDaemon: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("bounce");
    expect(calls[1]).toContain("helyx-admin.service");
    expect(r.steps).toHaveLength(2);
  });

  test("a failed bounce is a failed restart — no green tick survives it", async () => {
    const { run } = recorder({ bounce: { ok: false, output: "can't find session: bots" } });
    const r = await restartHostHalf(run, HOST_OPTS);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("✗");
    expect(r.summary).toContain("can't find session");
  });

  test("paths with spaces survive the shell", async () => {
    const { calls, run } = recorder();
    await restartHostHalf(run, { ...HOST_OPTS, botDir: "/home/a b/helyx" });
    expect(calls[0]).toContain("'/home/a b/helyx'");
  });

  test("the bounce is bounded so a hung tmux cannot wedge the queue", async () => {
    const { calls, run } = recorder();
    await restartHostHalf(run, HOST_OPTS);
    expect(calls[0]).toContain("timeout ");
  });
});

describe("restartDockerHalf", () => {
  test("creates what is missing, then restarts what is there", async () => {
    const { calls, run } = recorder();
    const r = await restartDockerHalf(run, { botDir: "/app" });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("docker compose up -d");
    expect(calls[1]).toContain("docker compose restart");
  });

  test("a failing up -d does not cancel the restart of the containers that are there", async () => {
    const { calls, run } = recorder({ "up -d": { ok: false, output: "no such image" } });
    const r = await restartDockerHalf(run, { botDir: "/app" });
    expect(calls).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(r.steps[0].ok).toBe(false);
    expect(r.steps[1].ok).toBe(true);
  });

  test("does not rebuild — a restart is meant to take seconds", async () => {
    const { calls, run } = recorder();
    await restartDockerHalf(run, { botDir: "/app" });
    expect(calls.some((c) => c.includes("--build"))).toBe(false);
  });

  test("each step is reported separately", async () => {
    const { run } = recorder({ restart: { ok: false, output: "boom" } });
    const r = await restartDockerHalf(run, { botDir: "/app" });
    expect(r.summary).toContain("✓ docker compose up -d");
    expect(r.summary).toContain("✗ docker compose restart");
  });
});

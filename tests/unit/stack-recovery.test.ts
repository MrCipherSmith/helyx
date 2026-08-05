/**
 * Bringing the stack back, and being able to see that it is down.
 *
 * Two restarts failed the same way: the system has a container half and a tmux
 * half, every command touched one of them, and nothing said which. The
 * operator restarted the bot and the sessions stayed dead — silently, because
 * the panel that should have shown it was reading a table that has never
 * existed in any migration, and swallowing the error.
 */

import { describe, test, expect } from "bun:test";
import { bringStackUp } from "../../scripts/stack-up.ts";
import { renderHealthLines, HEALTH_STALE_MS, type HealthRow } from "../../bot/commands/system.ts";
import { stackUpCallbackData, parseSupervisorCallback } from "../../utils/supervisor-callbacks.ts";

const OPTIONS = { botDir: "/srv/helyx", bunBin: "/usr/bin/bun", cli: "/srv/helyx/cli.ts" };

function recorder(fail?: (cmd: string) => boolean) {
  const cmds: string[] = [];
  const run = async (cmd: string) => {
    cmds.push(cmd);
    return { ok: !fail?.(cmd), output: fail?.(cmd) ? "boom" : "ok" };
  };
  return { cmds, run };
}

describe("bringing the stack up", () => {
  test("containers first, then the sessions", async () => {
    // A session that starts before Postgres cannot register itself, and the
    // channel it spawns attaches to nothing.
    const { cmds, run } = recorder();

    await bringStackUp(run, OPTIONS);

    expect(cmds.length).toBe(2);
    expect(cmds[0]).toContain("docker compose up -d");
    expect(cmds[1]).toContain("cli.ts");
    expect(cmds[1]).toContain(" up");
  });

  test("every step runs in the project directory", async () => {
    const { cmds, run } = recorder();

    await bringStackUp(run, OPTIONS);

    for (const cmd of cmds) expect(cmd).toContain("/srv/helyx");
  });

  test("a failing first step does not cancel the second", async () => {
    // A host whose compose is broken should still get its sessions back, and
    // the summary should say what did not work.
    const { cmds, run } = recorder((c) => c.includes("compose"));

    const result = await bringStackUp(run, OPTIONS);

    expect(cmds.length).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("✗ docker compose up -d");
    expect(result.summary).toContain("✓ helyx up");
  });

  test("nothing is reported as ok unless every step was", async () => {
    const { run } = recorder((c) => c.includes("cli.ts"));
    expect((await bringStackUp(run, OPTIONS)).ok).toBe(false);
  });

  test("all steps ok is ok", async () => {
    const { run } = recorder();
    expect((await bringStackUp(run, OPTIONS)).ok).toBe(true);
  });

  test("containersOnly skips the tmux half", async () => {
    const { cmds, run } = recorder();

    await bringStackUp(run, { ...OPTIONS, containersOnly: true });

    expect(cmds.length).toBe(1);
    expect(cmds[0]).toContain("docker compose");
  });

  test("a path with a space or a quote cannot break out of the command", async () => {
    // Asserted against a real shell rather than against the escaping rule: the
    // rule is what is under test, and a test that restates it would agree with
    // any mistake it contained.
    const hostile = "/srv/my helyx'; rm -rf /";
    const { cmds, run } = recorder();

    await bringStackUp(run, { ...OPTIONS, botDir: hostile });

    const quoted = cmds[0]!.slice("cd ".length, cmds[0]!.indexOf(" && "));
    const proc = Bun.spawn(["bash", "-c", `printf '%s' ${quoted}`], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    // One argument, byte-identical: the `;` never reached the shell as a separator.
    expect(out).toBe(hostile);
  });

  test("every step is bounded in time", async () => {
    // The command queue is single-threaded and the recovery path runs through
    // it. A hung docker daemon must not wedge it.
    const { cmds, run } = recorder();

    await bringStackUp(run, OPTIONS);

    for (const cmd of cmds) expect(cmd).toContain("timeout ");
  });
});

describe("the health section of /system", () => {
  const fresh = new Date(Date.now()).toISOString();

  test("shows the host processes and our containers", () => {
    const rows: HealthRow[] = [
      { name: "admin-daemon", status: "running", updated_at: fresh },
      { name: "supervisor", status: "running", updated_at: fresh },
      { name: "docker:helyx-bot-1", status: "running", updated_at: fresh },
      { name: "docker:helyx-postgres-1", status: "running", updated_at: fresh },
    ];

    const lines = renderHealthLines(rows, Date.now(), "helyx");

    expect(lines.join("\n")).toContain("admin-daemon");
    expect(lines.join("\n")).toContain("supervisor");
    expect(lines.join("\n")).toContain("helyx-bot-1");
    expect(lines.every((l) => l.startsWith("✅"))).toBe(true);
  });

  test("and not the dozen unrelated containers on the host", () => {
    // `process_health` carries whatever `docker ps` returned. A control panel
    // listing someone else's stack is one nobody reads.
    const rows: HealthRow[] = [
      { name: "admin-daemon", status: "running", updated_at: fresh },
      { name: "supervisor", status: "running", updated_at: fresh },
      { name: "docker:helyx-bot-1", status: "running", updated_at: fresh },
      { name: "docker:deprecated-web", status: "running", updated_at: fresh },
      { name: "docker:portainer", status: "running", updated_at: fresh },
    ];

    const joined = renderHealthLines(rows, Date.now(), "helyx").join("\n");

    expect(joined).not.toContain("deprecated-web");
    expect(joined).not.toContain("portainer");
  });

  test("a stopped container is not quietly missing — it is a warning", () => {
    const rows: HealthRow[] = [
      { name: "admin-daemon", status: "running", updated_at: fresh },
      { name: "supervisor", status: "running", updated_at: fresh },
      { name: "docker:helyx-bot-1", status: "stopped", updated_at: fresh },
    ];

    const joined = renderHealthLines(rows, Date.now(), "helyx").join("\n");

    expect(joined).toContain("⚠️ helyx-bot-1");
  });

  test("a heartbeat that stopped arriving is not a green light", () => {
    // The writer runs every 30s. A row three beats old is the last thing that
    // was true, not the current state — and it is exactly what a dead daemon
    // leaves behind.
    const stale = new Date(Date.now() - HEALTH_STALE_MS - 1000).toISOString();
    const rows: HealthRow[] = [
      { name: "admin-daemon", status: "running", updated_at: stale },
      { name: "supervisor", status: "running", updated_at: stale },
    ];

    const joined = renderHealthLines(rows, Date.now(), "helyx").join("\n");

    expect(joined).toContain("🟡 admin-daemon");
    expect(joined).toContain("нет свежего heartbeat");
  });

  test("an empty table says so instead of rendering nothing", () => {
    // The defect this replaced: the query named a table that does not exist,
    // the error was caught, and the section silently disappeared. A panel with
    // no health lines looks like a system with nothing to report.
    const lines = renderHealthLines([], Date.now(), "helyx");

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("нет данных");
  });
});

describe("the recovery button", () => {
  test("round-trips through the callback codec", () => {
    // The restart button once spent its life throwing "project not found"
    // because the two ends spelled the format out separately.
    expect(parseSupervisorCallback(stackUpCallbackData())).toEqual({ action: "stack_up" });
  });

  test("and is still distinguishable from the other id-less actions", () => {
    expect(parseSupervisorCallback("sup:bounce")).toEqual({ action: "bounce" });
    expect(parseSupervisorCallback("sup:ignore")).toEqual({ action: "ignore" });
    expect(parseSupervisorCallback("sup:stack_up_extra")).toEqual({
      action: "unknown",
      raw: "sup:stack_up_extra",
    });
  });
});

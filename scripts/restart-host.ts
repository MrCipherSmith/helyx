/**
 * Restarting everything that is not a container.
 *
 * The operator thinks in two halves — the containers, and everything else —
 * and until now only the containers had a command that said so. "Everything
 * else" is the tmux session `bots`, the Claude Code process in each of its
 * windows, the `channel.ts` MCP subprocess each of those spawns, and the
 * host-side admin daemon that carries the supervisor.
 *
 * There is one function here and two callers — the `bounce` button and the new
 * `/restart_host` command — on purpose. The 2026-08-05 outage was a bug in one
 * start path that four different buttons all reached, and the repair is worth
 * nothing if the new command becomes a fifth door to the same room.
 *
 * Like `stack-up.ts` it takes its shell rather than importing one: the daemon
 * runs commands from the database queue, and the host ingress runs them when
 * the database is what is unreachable.
 */

import type { RunShell } from "./stack-up.ts";

export interface RestartHostStep {
  name: string;
  ok: boolean;
  output: string;
}

export interface RestartHostResult {
  ok: boolean;
  steps: RestartHostStep[];
  /** One line per step, for a Telegram reply or an `admin_commands.result`. */
  summary: string;
}

/**
 * How long the bounce may take.
 *
 * Ten windows, each starting a Claude Code process, is not a two-second
 * operation; and the queue this runs through is single-threaded, so a hung
 * tmux must not be able to wedge it for ever.
 */
export const BOUNCE_TIMEOUT_SEC = 300;

export interface RestartHostOptions {
  botDir: string;
  /** Absolute path to `bun` — the daemon's PATH is systemd's, not a login shell's. */
  bunBin: string;
  /** Absolute path to `cli.ts`. */
  cli: string;
  /**
   * Also restart `helyx-admin.service`, which carries the supervisor.
   *
   * Off by default because it is the one step that kills the caller: the
   * daemon spawns this work inside its own cgroup, and `systemctl restart`
   * takes that cgroup down. Callers that want it must be detached and must
   * accept that nothing after it runs.
   */
  restartAdminDaemon?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bounce the sessions, then optionally the daemon.
 *
 * The order is deliberate. `helyx-admin.service` runs `helyx up` after every
 * start, so restarting it first would create the windows this is about to kill
 * — a restart that fights itself. Sessions first, daemon last.
 *
 * `bounce` exits non-zero when the session half did not come up; that check
 * lives in `cli.ts` and is the whole point of the flow this belongs to. Here it
 * is simply believed, which is only safe because it is now true.
 */
export async function restartHostHalf(
  run: RunShell,
  options: RestartHostOptions,
): Promise<RestartHostResult> {
  const { botDir, bunBin, cli, restartAdminDaemon } = options;
  const cd = `cd ${shellQuote(botDir)}`;
  const steps: RestartHostStep[] = [];

  // This caller already holds the restart lease — `restart-host-run.ts` runs
  // inside a process spawned only after `admin-daemon.ts`'s `claimRestart()`
  // succeeded. `HELYX_RESTART_LEASE_HELD=1` tells `cli.ts`'s own `bounce`
  // branch not to take it a second time, which would refuse itself: the same
  // lease file does not know "this is the same restart, one level down."
  const bounce = await run(
    `${cd} && HELYX_RESTART_LEASE_HELD=1 timeout ${BOUNCE_TIMEOUT_SEC} ${shellQuote(bunBin)} ${shellQuote(cli)} bounce 2>&1`,
  );
  steps.push({
    name: "bounce (tmux windows, claude, channel.ts)",
    ok: bounce.ok,
    output: bounce.output,
  });

  if (restartAdminDaemon) {
    // Last, and nothing may follow it: this ends the process running these
    // steps. `--no-block` at least lets the command return before it does.
    const daemon = await run(
      `systemctl --user restart --no-block helyx-admin.service 2>&1 || true`,
    );
    steps.push({
      name: "restart helyx-admin.service (admin-daemon + supervisor)",
      ok: daemon.ok,
      output: daemon.output,
    });
  }

  const ok = steps.every((s) => s.ok);
  const summary = steps
    .map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.output ? `\n${s.output.slice(0, 600)}` : ""}`)
    .join("\n\n");

  return { ok, steps, summary };
}

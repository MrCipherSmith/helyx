/**
 * Restarting the container half, and only the container half.
 *
 * `docker_restart` already existed and takes a single container name, which is
 * useful when you know which one is wrong and useless when you just want the
 * containers restarted. This is the second of the operator's two halves, named
 * the way the operator names it — see `restart-host.ts` for the other.
 *
 * Two steps rather than one. `docker compose restart` restarts what is running
 * and does nothing at all for a container that was removed — and `compose down`
 * removes rather than stops, so "missing" is a normal state here, not an exotic
 * one. `up -d` fills those gaps first; `restart` then gives everything an
 * actual restart, including the containers `up -d` left alone because they were
 * already fine.
 */

import type { RunShell } from "./stack-up.ts";

export interface RestartDockerStep {
  name: string;
  ok: boolean;
  output: string;
}

export interface RestartDockerResult {
  ok: boolean;
  steps: RestartDockerStep[];
  summary: string;
}

/** Long enough for a cold pull, short enough not to wedge the command queue. */
export const DOCKER_STEP_TIMEOUT_SEC = 240;

export interface RestartDockerOptions {
  botDir: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bring up whatever is missing, then restart everything.
 *
 * A failing first step does not stop the second: a host where `up -d` cannot
 * create the container it is missing should still get a restart of the ones it
 * has, and the summary says which part did not work rather than collapsing
 * both into one verdict.
 *
 * This deliberately does not rebuild. New code reaching the bot is
 * `full_restart`'s job, and an operator asking for a restart is usually asking
 * for the thing that takes seconds, not the thing that takes minutes.
 */
export async function restartDockerHalf(
  run: RunShell,
  options: RestartDockerOptions,
): Promise<RestartDockerResult> {
  const cd = `cd ${shellQuote(options.botDir)}`;
  const steps: RestartDockerStep[] = [];

  const up = await run(`${cd} && timeout ${DOCKER_STEP_TIMEOUT_SEC} docker compose up -d 2>&1`);
  steps.push({ name: "docker compose up -d (create what is missing)", ok: up.ok, output: up.output });

  const restart = await run(`${cd} && timeout ${DOCKER_STEP_TIMEOUT_SEC} docker compose restart 2>&1`);
  steps.push({ name: "docker compose restart (restart what is there)", ok: restart.ok, output: restart.output });

  const ok = steps.every((s) => s.ok);
  const summary = steps
    .map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.output ? `\n${s.output.slice(0, 600)}` : ""}`)
    .join("\n\n");

  return { ok, steps, summary };
}

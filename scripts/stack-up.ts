/**
 * Bringing the whole stack back, in one place.
 *
 * There was no such place, and that is what the two failed restarts were about.
 * The system has two halves — containers, and tmux windows running Claude Code —
 * and every command that existed touched exactly one of them. `helyx restart`
 * rebuilds the bot container. `bounce` restarts the tmux sessions. `helyx stop`
 * takes both down, and nothing at all brought both back up. So an operator who
 * said "restart" got whichever half the command they happened to run knew
 * about, and the other half stayed dead without anything saying so.
 *
 * This is deliberately idempotent rather than a restart: `compose up -d` starts
 * what is missing and leaves what is running alone, and `helyx up` starts the
 * tmux windows that are absent and skips the ones that are not. It is the
 * command for "whatever is down, bring it up", which is what a recovery button
 * has to mean — the operator pressing it does not know which half is broken,
 * and a command that tears down the working half to be sure would turn a
 * partial outage into a full one.
 *
 * It takes its shell rather than importing one because both callers already
 * have theirs: `admin-daemon.ts` runs commands from the DB queue, and
 * `host-ingress.ts` runs them when the DB is exactly what is unreachable.
 */

export type RunShell = (cmd: string) => Promise<{ ok: boolean; output: string }>;

export interface StackUpStep {
  name: string;
  ok: boolean;
  output: string;
}

export interface StackUpResult {
  ok: boolean;
  steps: StackUpStep[];
  /** One line per step, for a Telegram reply or an `admin_commands.result`. */
  summary: string;
}

/**
 * How long a step may take.
 *
 * `compose up -d` pulls and creates; on a cold host that is minutes, not
 * seconds. The timeout is here so a hung docker daemon cannot wedge the
 * command queue — which is single-threaded, and which the recovery path itself
 * runs through.
 */
export const STEP_TIMEOUT_SEC = 240;

/** Where `helyx up` and `docker compose` must run. */
export interface StackUpOptions {
  botDir: string;
  /** Absolute path to the `bun` binary — the daemon's PATH is systemd's, not a login shell's. */
  bunBin: string;
  /** Absolute path to `cli.ts`. */
  cli: string;
  /** Skip the tmux half. Used when only the containers are known to be down. */
  containersOnly?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start whatever is down, containers first.
 *
 * The order is not cosmetic. A Claude Code session that comes up before
 * Postgres does cannot register itself, and the channel it starts attaches to
 * nothing — so the tmux half is worth nothing until the container half is
 * serving. Failing steps do not stop the rest: a host where compose is broken
 * should still get its sessions back, and the summary says what did not work.
 */
export async function bringStackUp(run: RunShell, options: StackUpOptions): Promise<StackUpResult> {
  const { botDir, bunBin, cli, containersOnly } = options;
  const steps: StackUpStep[] = [];
  const cd = `cd ${shellQuote(botDir)}`;

  const compose = await run(`${cd} && timeout ${STEP_TIMEOUT_SEC} docker compose up -d 2>&1`);
  steps.push({ name: "docker compose up -d", ok: compose.ok, output: compose.output });

  if (!containersOnly) {
    // `helyx up` starts the tmux windows that are missing and reports the ones
    // already running — see `tmuxStart` in cli.ts. Running it against a live
    // session is a no-op, which is the property the recovery button needs.
    const tmux = await run(
      `${cd} && timeout ${STEP_TIMEOUT_SEC} ${shellQuote(bunBin)} ${shellQuote(cli)} up 2>&1`,
    );
    steps.push({ name: "helyx up (tmux sessions)", ok: tmux.ok, output: tmux.output });
  }

  const ok = steps.every((s) => s.ok);
  const summary = steps
    .map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.output ? `\n${s.output.slice(0, 600)}` : ""}`)
    .join("\n\n");

  return { ok, steps, summary };
}

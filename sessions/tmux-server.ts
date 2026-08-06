/**
 * The two judgements a `helyx up` has to make before it may claim to have
 * worked, kept away from the shell so they can be tested without staging an
 * outage.
 *
 * Both of them were missing on 2026-08-05 and the restart that followed left
 * every Claude session dead while reporting success. See
 * `docs/restart-problem.md` for the incident and `.metaproject/flows/048-*` for the
 * work this belongs to.
 */

/** The transient unit name the tmux server is put under. */
export const TMUX_SCOPE_UNIT = "helyx-tmux";

/** `helyx-tmux` as systemd refers to it once loaded. */
export const TMUX_SCOPE_UNIT_FILE = `${TMUX_SCOPE_UNIT}.scope`;

export interface TmuxScopeEnv {
  /** `process.platform`. The scope is a systemd concept and Linux-only. */
  platform: string;
  /** Whether `systemd-run` is on PATH. */
  hasSystemdRun: boolean;
  /** Whether a tmux server is already answering — `tmux list-sessions` succeeds. */
  hasTmuxServer: boolean;
}

export interface TmuxScopeDecision {
  /** Prefix for the first `tmux new-session`. Empty when none is wanted. */
  prefix: string[];
  /**
   * Whether a unit left behind by a previous server has to be cleared first.
   * Only ever true when no server is running: stopping the unit while one is
   * would kill the server, and with it every session sharing it.
   */
  clearUnit: boolean;
  /** Why, in one line, for the log the operator reads after a failed restart. */
  reason: string;
}

/**
 * Whether the first tmux window needs its own systemd scope.
 *
 * The scope exists for one reason: without it the tmux server inherits the
 * cgroup of whoever ran `helyx up`, in practice `helyx-admin.service`, and
 * `systemctl restart helyx-admin` then takes every CLI pane down with it.
 *
 * That reason applies to the *first* server and to nothing else. The unit
 * tracks the server, not the `bots` session, so it stays active for as long as
 * any session keeps that server alive — a bench run, a stray window, anything.
 * `systemd-run --unit=helyx-tmux` against a live unit fails with "already
 * loaded or has a fragment file", and the old code's `reset-failed` could not
 * help: it clears a unit systemd calls *failed*, and this one is *active*. The
 * result was a permanent collision that survived every retry, every button, and
 * both restart paths.
 *
 * So: if a server is already up, join it with a plain `new-session`. There is
 * no cgroup to escape — the running server is already wherever it is going to
 * be — and no unit to collide with.
 */
export function decideTmuxScope(env: TmuxScopeEnv): TmuxScopeDecision {
  if (env.platform !== "linux") {
    return { prefix: [], clearUnit: false, reason: "not linux — no systemd scope" };
  }
  if (!env.hasSystemdRun) {
    return { prefix: [], clearUnit: false, reason: "systemd-run not available" };
  }
  if (env.hasTmuxServer) {
    return {
      prefix: [],
      clearUnit: false,
      reason: "tmux server already running — joining it, no scope needed",
    };
  }
  return {
    prefix: ["systemd-run", "--user", "--scope", `--unit=${TMUX_SCOPE_UNIT}`, "--collect", "--quiet"],
    clearUnit: true,
    reason: "no tmux server — starting one under its own scope",
  };
}

export interface StartOutcome {
  /** Whether `tmux has-session -t bots` succeeds after the run. */
  sessionExists: boolean;
  /** Window names actually present, from `tmux list-windows`. */
  windows: ReadonlySet<string>;
  /** Windows whose start command returned non-zero, with the reason. */
  failed: readonly { window: string; error: string }[];
  /** Windows the run was supposed to create. Empty means nothing was asked of it. */
  expected: readonly string[];
}

export interface StartVerdict {
  ok: boolean;
  /** One line per problem. Empty when ok. */
  problems: string[];
  /** A single line fit for a Telegram reply or an `admin_commands.result`. */
  summary: string;
}

/**
 * Whether a start actually started anything.
 *
 * The incident's signature is that every individual step *looked* fine — the
 * log carried green ticks — while the session did not exist at all. So the
 * verdict is not assembled from the steps' opinions of themselves. It asks tmux
 * what is there, and treats "nothing" as failure however cheerful the steps
 * were.
 *
 * A run that was asked to start nothing is not a failure. That is `helyx up`
 * against a fully running session, which is the no-op the recovery button
 * depends on.
 */
export function verifyStart(outcome: StartOutcome): StartVerdict {
  const problems: string[] = [];

  if (outcome.expected.length === 0 && outcome.failed.length === 0) {
    return { ok: true, problems: [], summary: "nothing to start — all windows already running" };
  }

  if (!outcome.sessionExists) {
    problems.push("tmux session 'bots' does not exist after the start");
  } else if (outcome.windows.size === 0) {
    problems.push("tmux session 'bots' has no windows after the start");
  }

  for (const f of outcome.failed) {
    problems.push(`${f.window}: ${f.error}`);
  }

  const missing = outcome.expected.filter((w) => !outcome.windows.has(w));
  const alreadyReported = new Set(outcome.failed.map((f) => f.window));
  for (const w of missing) {
    if (!alreadyReported.has(w)) problems.push(`${w}: window missing after the start`);
  }

  if (problems.length > 0) {
    return {
      ok: false,
      problems,
      summary: `${problems.length} problem(s): ${problems.join("; ")}`,
    };
  }

  return {
    ok: true,
    problems: [],
    summary: `${outcome.windows.size} window(s) running in 'bots'`,
  };
}

/** The name the tmux half is filed under in `process_health`. */
export const TMUX_HEALTH_NAME = "tmux:bots";

export interface TmuxHostFacts {
  /** `tmux has-session -t bots` succeeded. */
  sessionExists: boolean;
  /** Window names from `tmux list-windows`, empty when there is no session. */
  windowNames: readonly string[];
  /**
   * `systemctl --user is-active helyx-tmux.scope`, or null where there is no
   * systemd to ask — macOS, or a container.
   */
  scopeState: string | null;
}

export interface TmuxHealthRow {
  status: string;
  detail: { session: boolean; windows: number; scope: string | null; names: string[] };
}

/**
 * Normalise `systemctl --user is-active helyx-tmux.scope`.
 *
 * The command exits non-zero for every state except `active`, so its output is
 * the answer and its exit code is not. Empty output means there was no
 * systemd to ask, which is a different thing from `inactive` and must not be
 * rendered as one.
 */
export function parseScopeState(output: string): string | null {
  const state = output.trim().split("\n")[0]?.trim() ?? "";
  return state === "" ? null : state;
}

/**
 * The host's own account of the session half, for the `/system` panel.
 *
 * The panel used to count rows in `sessions`, and during the outage that
 * counter read zero — which is true of a session half that never started and
 * equally true of one that started and failed to register itself. Those need
 * different repairs, and the operator could not tell them apart from Telegram.
 * Window count answers it: no windows means nothing started.
 */
export function summarizeTmuxHost(facts: TmuxHostFacts): TmuxHealthRow {
  const windows = facts.windowNames.length;
  const running = facts.sessionExists && windows > 0;
  return {
    status: running ? "running" : "stopped",
    detail: {
      session: facts.sessionExists,
      windows,
      scope: facts.scopeState,
      names: [...facts.windowNames],
    },
  };
}

/**
 * The panel's line for the tmux half.
 *
 * Spelled out rather than reduced to running/stopped, because "session exists,
 * 0 windows" is the exact state the incident produced and the one an icon
 * would flatten into the same red dot as "no session at all".
 */
export function renderTmuxHealthLine(
  detail: Pick<TmuxHealthRow["detail"], "session" | "windows" | "scope"> | null,
): string {
  if (!detail) return "❔ tmux: нет данных";
  if (!detail.session) {
    const scope = detail.scope === "active"
      ? " (scope active — сервер жив, сессии нет)"
      : "";
    return `⚠️ tmux: сессии 'bots' нет${scope}`;
  }
  if (detail.windows === 0) {
    return "⚠️ tmux: сессия 'bots' есть, окон 0 — ничего не стартовало";
  }
  return `✅ tmux: ${detail.windows} окон в 'bots'`;
}

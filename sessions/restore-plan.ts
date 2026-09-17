/**
 * Which projects a start is allowed to bring up.
 *
 * Until flow 067 the answer was "all of them", because `tmuxStart` read the
 * whole `projects` table and nothing narrowed it. A host reboot, a code deploy
 * and a recovery button were therefore the same event, and each one handed the
 * operator fifteen Claude Code sessions.
 *
 * Two different questions hide behind that one answer:
 *
 *   - a COLD start — the first `up` after the host booted — should bring up
 *     only what is flagged for autostart (`helyx`, so the rest can be started
 *     from Telegram on demand);
 *   - a RESTART inside the same boot — `bounce`, `full_restart`,
 *     `host_restart`, or the `stack_up` that follows a `tmux_stop` — should
 *     bring back exactly what was live when the teardown began.
 *
 * Neither set substitutes for the other, so both are recorded: the flag on
 * `projects`, and a snapshot written by `tmuxStop` *before* it kills anything.
 * Telling the two cases apart is the host's boot id: it is stable for as long
 * as the machine stays up and new after every reboot, which is precisely the
 * distinction being made. A freshness timeout on the snapshot was considered
 * and rejected — it answers "how old" when the question is "was there a
 * reboot", and picks an arbitrary number to do it.
 *
 * Kept free of tmux and of the database for the same reason
 * `sessions/tmux-server.ts` is: the judgement is the part worth testing, and
 * the shell calls are the part that cannot be.
 */

/** The project a cold start falls back to when nothing is flagged. */
export const BOOTSTRAP_PROJECT = "helyx";

/** `host_state` key holding the boot id of the last successful start. */
export const HOST_STATE_BOOT_ID = "session_boot_id";

/** `host_state` key holding the window names live at the last teardown. */
export const HOST_STATE_SNAPSHOT = "session_snapshot";

export interface StartCandidate {
  name: string;
  path: string;
  autostart: boolean;
}

export interface StartSetEnv {
  /**
   * The host's current boot id. `null` when it could not be read — treated as
   * a cold start, see `decideStartSet`.
   */
  bootId: string | null;
  /** The boot id recorded after the last successful start; `null` when none. */
  storedBootId: string | null;
  /**
   * Window names recorded by the last teardown. `null` means nothing was
   * recorded or the record could not be read; an empty array means the
   * teardown genuinely found no windows.
   */
  snapshot: readonly string[] | null;
  /** Every configured project whose path exists, in configured order. */
  projects: readonly StartCandidate[];
}

export interface StartSetDecision {
  /** The projects to start, in the order they were configured. */
  start: StartCandidate[];
  /** Whether this was judged a cold start. */
  cold: boolean;
  /** Why, in one line, for the console and the flow journal. */
  reason: string;
}

/** The autostart set, falling back to the bootstrap project when nothing is flagged. */
function autostartSet(projects: readonly StartCandidate[]): {
  set: StartCandidate[];
  viaBootstrap: boolean;
} {
  const flagged = projects.filter((p) => p.autostart);
  if (flagged.length > 0) return { set: flagged, viaBootstrap: false };
  const bootstrap = projects.filter((p) => p.name === BOOTSTRAP_PROJECT);
  return { set: bootstrap, viaBootstrap: bootstrap.length > 0 };
}

/**
 * Decide what a start brings up.
 *
 * An unreadable boot id counts as cold. The alternative — treating "I cannot
 * tell" as a restart — restores the whole fleet after exactly the event this
 * change exists to stop, and does it silently; starting the autostart set
 * instead costs the operator one tap per project they actually wanted, and the
 * reason line says why they had to.
 *
 * A restart never returns the empty set from an empty snapshot. A restart that
 * brings up nothing at all is the 2026-08-05 outage (see
 * `sessions/tmux-server.ts`), and "nothing was recorded" is not evidence that
 * nothing should run — it is evidence that the record is missing.
 */
export function decideStartSet(env: StartSetEnv): StartSetDecision {
  const { bootId, storedBootId, snapshot, projects } = env;
  const fallback = autostartSet(projects);

  const coldReason = (why: string): StartSetDecision => ({
    start: fallback.set,
    cold: true,
    reason: fallback.viaBootstrap
      ? `${why} — no project flagged autostart, starting ${BOOTSTRAP_PROJECT} alone`
      : `${why} — starting the ${fallback.set.length} autostart project(s)`,
  });

  if (bootId === null) return coldReason("boot id unreadable, assuming a cold start");
  if (storedBootId === null) return coldReason("no boot id recorded yet");
  if (bootId !== storedBootId) return coldReason("host rebooted since the last start");

  if (snapshot === null) {
    return {
      start: fallback.set,
      cold: false,
      reason: "same boot but no usable snapshot — falling back to the autostart set",
    };
  }

  const wanted = new Set(snapshot);
  const restored = projects.filter((p) => wanted.has(p.name));
  if (restored.length === 0) {
    return {
      start: fallback.set,
      cold: false,
      reason: snapshot.length === 0
        ? "same boot, snapshot empty — falling back to the autostart set"
        : "same boot, but no snapshot entry matches a configured project — falling back to the autostart set",
    };
  }

  const missing = snapshot.filter((name) => !projects.some((p) => p.name === name));
  const note = missing.length > 0 ? ` (${missing.length} snapshot entry/entries no longer configured)` : "";
  return {
    start: restored,
    cold: false,
    reason: `restoring the ${restored.length} session(s) live at the last teardown${note}`,
  };
}

/** Serialize a snapshot for `host_state.value`. */
export function encodeSnapshot(windows: readonly string[]): string {
  return JSON.stringify(windows);
}

/**
 * Read a snapshot back.
 *
 * Returns `null` for anything that is not a JSON array of strings — absent,
 * truncated, or written by a future version with a different shape. `null` and
 * `[]` are kept distinct on purpose: `decideStartSet` reports them differently,
 * and collapsing "unreadable" into "empty" would hide a corrupted record behind
 * a plausible-looking one.
 */
export function decodeSnapshot(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((entry): entry is string => typeof entry === "string")) return null;
    return parsed.map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

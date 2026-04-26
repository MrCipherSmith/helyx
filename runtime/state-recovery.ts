/**
 * Startup state-recovery sweeps for the agent runtime layer.
 *
 * Runtime state machines have transient intermediate states ('starting',
 * 'stopping', 'waiting_approval') that the daemon sets BEFORE invoking
 * the driver / before a human resolves a prompt. If the daemon crashes
 * mid-transition, those rows become ghosts — no actor in the system
 * touches them again because each reconcile branch treats them as
 * "in-flight, don't disturb". This module collects the one-shot sweeps
 * that should run at daemon startup to recover from such crashes.
 *
 * Kept separate from runtime-manager.ts so the recovery contract is
 * unit-testable in isolation (the runtime-manager singleton has heavier
 * driver-registration side-effects).
 */

import type postgres from "postgres";

export interface StateSweepResult {
  /** Number of rows reset by the staleness-bounded transient sweep. */
  staleTransient: number;
  /** Number of rows reset by the orphaned waiting_approval sweep. */
  orphanedApproval: number;
}

/**
 * Reset rows whose `actual_state` is a transient intermediate that should
 * not survive a daemon crash.
 *
 * - `starting` and `stopping` are set by the reconciler immediately before
 *   calling `driver.start()` / `driver.stop()`. A crash before the call
 *   completes (or before the next tick observes the new health) leaves
 *   them stuck — the reconciler will never spontaneously re-evaluate
 *   because its branching logic treats 'starting' as "in-flight, the
 *   previous attempt is still finishing".
 *
 * The sweep is bounded by `last_health_at` staleness so it does not
 * interfere with the *current* daemon's in-flight transitions. The
 * 60-second default comfortably exceeds the typical reconcile tick
 * (~5s) and any realistic `driver.start` latency.
 *
 * Reset target is `'stopped'`: the next reconcile pass will probe
 * health, observe whether the tmux window actually survived, and
 * either flip to `'running'` or call `driver.start` again (subject
 * to the per-instance restart budget).
 */
export async function sweepStaleTransientStates(
  sql: postgres.Sql<{}>,
  staleSeconds: number = 60,
): Promise<number> {
  // postgres.js parameter-binds the integer; interval string is built
  // server-side via make_interval to avoid SQL injection from a non-int
  // staleSeconds value (defense-in-depth even though the type system
  // already enforces number).
  const result = (await sql`
    UPDATE agent_instances
    SET actual_state = 'stopped', updated_at = now()
    WHERE actual_state IN ('starting','stopping')
      AND (last_health_at IS NULL OR last_health_at < now() - make_interval(secs => ${staleSeconds}))
  `) as unknown as { count: number };
  return Number(result?.count ?? 0);
}

/**
 * Reset rows stuck in `actual_state = 'waiting_approval'` from a previous
 * watchdog crash. The watchdog sets this state when it detects a permission
 * prompt and clears it on resolution; a mid-prompt crash leaves the row
 * permanently flagged because the reconciler skips waiting-approval
 * instances by contract.
 *
 * Reset to `'running'` — if the prompt is still on screen, the watchdog
 * re-detects within ~5s and re-flags. No staleness bound: a live watchdog
 * would not have left a row in this state across a daemon restart, so
 * any matching row is by definition orphaned.
 */
export async function sweepOrphanedWaitingApproval(
  sql: postgres.Sql<{}>,
): Promise<number> {
  const result = (await sql`
    UPDATE agent_instances
    SET actual_state = 'running', updated_at = now()
    WHERE actual_state = 'waiting_approval'
  `) as unknown as { count: number };
  return Number(result?.count ?? 0);
}

/**
 * Run all startup state-recovery sweeps. Errors per sweep are caught
 * and logged via the supplied warn callback so a single failure does
 * not abort the others — daemon startup must remain resilient.
 */
export async function runStartupSweeps(
  sql: postgres.Sql<{}>,
  warn: (msg: string, err: unknown) => void = (m, e) => console.warn(m, e),
): Promise<StateSweepResult> {
  let orphanedApproval = 0;
  let staleTransient = 0;
  try {
    orphanedApproval = await sweepOrphanedWaitingApproval(sql);
  } catch (err) {
    warn("[state-recovery] waiting_approval sweep failed:", err);
  }
  try {
    staleTransient = await sweepStaleTransientStates(sql);
  } catch (err) {
    warn("[state-recovery] transient state sweep failed:", err);
  }
  return { staleTransient, orphanedApproval };
}

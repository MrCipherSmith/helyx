/**
 * The gate above the restart lease.
 *
 * `claimRestart` (`utils/restart-lease.ts`) answers "is another restart
 * already running?" — a mutex, not an approval. This answers the question the
 * mutex cannot: "is this the action anybody agreed to?" It sits strictly
 * before the lease where a lease is taken at all (P-2.6: both questions are
 * asked, neither replaces the other) — an unapproved action is refused here
 * and never reaches `claimRestart`.
 *
 * **Corrected 2026-08-12.** This module first covered only the three commands
 * that take the restart lease. `specification.md` §A2 "The complete mapping"
 * names eight teardown-capable commands in `scripts/admin-daemon.ts`; only
 * three of them (`bounce`, `host_restart`, `full_restart`) also take the
 * lease. Approval and mutual exclusion are different questions, and the other
 * five are gated here without ever touching `claimRestart`.
 *
 * Kept out of `admin-daemon.ts` itself for the same reason `restart-host.ts`
 * and `restart-docker.ts` are: that file is a long-running daemon with real
 * side effects at import time, so it cannot be imported by a test. This module
 * has none, and a test can call it directly.
 */

import type postgres from "postgres";
import {
  fingerprintOf,
  presentGrant,
  describeFingerprint,
  type RestartAction,
} from "../utils/action-approval-grant.ts";

/**
 * Every teardown-capable command — the ones `fingerprintOf` derives a
 * fingerprint for, given a well-formed payload. Kept as an explicit set
 * rather than only "whatever `fingerprintOf` doesn't return null for" because
 * AC19 needs to enumerate `scripts/admin-daemon.ts`'s actual `case` labels and
 * check each one against a classification that does not silently agree with
 * itself.
 */
export const GATED_RESTART_COMMANDS = new Set([
  "bounce", "host_restart", "full_restart",
  "docker_restart", "docker_restart_all", "tmux_stop", "channel_kill", "proj_stop",
]);

/**
 * Of the eight, only these three ever held `claimRestart`'s lease — the other
 * five are gated without touching it (specification.md §A2 Integration
 * points: "only bounce, host_restart and full_restart take a lease at all").
 */
export const LEASE_TAKING_COMMANDS = new Set(["bounce", "host_restart", "full_restart"]);

/**
 * Bring-up only, exempt by decision (specification.md §A2 "The complete
 * mapping"): `stack_up` is the documented recovery path when the stack is
 * half-down, and gating the command that repairs an outage behind an approval
 * the operator may be unable to give is the wrong shape. A command that ever
 * gains a teardown step leaves this list.
 */
export const EXEMPT_BRING_UP_COMMANDS = new Set(["stack_up", "tmux_start", "proj_start"]);

/**
 * Outside the fingerprint model entirely — not a restart of any half.
 * `restart_admin_daemon` respawns the daemon process itself (neither
 * `container` nor `sessions` as this fingerprint defines them);
 * `tmux_send_keys` sends keystrokes into an already-running pane;
 * `supervisor_ack` only writes a row. None of the three take any half of the
 * system down.
 */
export const NOT_TEARDOWN_CAPABLE_COMMANDS = new Set(["restart_admin_daemon", "tmux_send_keys", "supervisor_ack"]);

export type GateResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Re-derive the fingerprint of `row` and check it against the grant named in
 * `row.payload.grantId`.
 *
 * No `grantId` at all is treated exactly like "no live approver reachable"
 * (P-2.3): denied, not allowed, and the lease is never touched — the caller
 * must not call `claimRestart` unless this returns `ok: true`.
 */
export async function authorizeRestart(
  sql: postgres.Sql,
  row: RestartAction,
  now: Date = new Date(),
): Promise<GateResult> {
  const fingerprint = fingerprintOf(row);
  if (!fingerprint) {
    // Not one of the eight gated commands — nothing to authorize. Callers are
    // expected to only invoke this for commands in GATED_RESTART_COMMANDS;
    // this is the safe default for anything else that reaches it by mistake.
    return { ok: true };
  }

  const grantId = row.payload?.grantId;
  if (typeof grantId !== "string" || !grantId) {
    return {
      ok: false,
      message: `no approver reachable — ${describeFingerprint(fingerprint)} was never approved`,
    };
  }

  const result = await presentGrant(sql, grantId, fingerprint, now);
  if (result.ok) return { ok: true };

  switch (result.reason) {
    case "not-found":
      return { ok: false, message: `no approver reachable — grant ${grantId} does not exist` };
    case "mismatch":
      return {
        ok: false,
        message:
          `grant issued for ${describeFingerprint(result.grantedFingerprint)} ` +
          `does not authorize ${describeFingerprint(result.actionFingerprint)}`,
      };
    case "consumed":
      return { ok: false, message: "grant already used — a grant authorizes one restart, not two" };
    case "expired":
      return { ok: false, message: "grant expired — restart approvals are answered immediately or not at all" };
  }
}

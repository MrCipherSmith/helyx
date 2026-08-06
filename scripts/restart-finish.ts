#!/usr/bin/env bun
/**
 * What runs when a detached restart is over, however it ended.
 *
 * The three restart commands hand their work to a detached process and leave
 * their queue row `processing` — the row is what the enqueue-time duplicate
 * check reads, and a row that goes `done` a second after a restart that takes
 * minutes started is a check that refuses nothing. Something has to close it
 * when the work is genuinely finished, and that something cannot be the daemon:
 * `host_restart` ends by restarting the daemon itself.
 *
 * Releasing the lease is the part that must not fail. Closing the row is best
 * effort: a `full_restart` rebuilds the bot container, and Postgres may be
 * unreachable for the seconds either side of that. A row left `processing`
 * ages out — the duplicate check ignores rows older than the lease expiry for
 * exactly this reason — whereas a lease left behind locks every restart out for
 * fifteen minutes.
 *
 * Both a module and a command: `restart-host-run.ts` calls the function in its
 * own process, and `full_restart`'s shell pipeline calls the file. One piece of
 * logic either way — a second copy in a bash string is a copy that drifts.
 *
 * Usage: restart-finish.ts [rowId] [ok|error]
 */

import { releaseRestartLease } from "../utils/restart-lease.ts";

/**
 * Release the lease, then close the row if there is one to close.
 *
 * The order is the guarantee: the release happens first and unconditionally,
 * and everything after it is a report about it.
 */
export async function finishRestart(rowId: number, status: "done" | "error" = "done"): Promise<void> {
  releaseRestartLease();

  if (!Number.isFinite(rowId) || rowId <= 0) return;
  try {
    const { sql } = await import("../memory/db.ts");
    await sql`
      UPDATE admin_commands
      SET status = ${status}, executed_at = now()
      WHERE id = ${rowId} AND status = 'processing'
    `;
    console.log(`[restart-finish] row ${rowId} → ${status}`);
  } catch (err) {
    // The lease is out, which is what matters. Say why the row was not closed,
    // so a `processing` row nobody expected has an explanation in the log.
    console.error(`[restart-finish] lease released; row ${rowId} left open: ${err}`);
  }
}

if (import.meta.main) {
  // The second argument is a shell exit status, because the caller that needs
  // it is a shell pipeline: `0` is a restart that worked and anything else is
  // one that did not. Absent means done — the callers that know they succeeded
  // should not have to say so twice. `error` is accepted as a word for a human
  // running this by hand.
  const code = process.argv[3];
  const failed = code !== undefined && code !== "0" && code !== "";
  await finishRestart(Number(process.argv[2]), failed ? "error" : "done");
  process.exit(0);
}

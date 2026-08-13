#!/usr/bin/env bun
/**
 * Declare a standing grant for an autonomous actor — the one exemption from
 * P-2.3 in the A2 package (see policies.md §P-2.3a).
 *
 * **Nothing holds a standing grant today, and that is deliberate.** The rule
 * was first written to protect a capability the watchdog was believed to have:
 * restarting a wedged session at 4am. It never had it — `tmux-watchdog.ts`
 * only alerts, and it still only alerts. The mechanism is kept because P-2.3
 * needs an answer for the day an autonomous actor does exist, and that answer
 * is better decided now than under pressure. This script is how such a grant
 * would be issued; running it is a decision, not a setup step.
 *
 * Not a Telegram command, deliberately: "declared, not implicit" (P-2.3a)
 * means an operator authorizing this does so somewhere that is obviously an
 * administrative action, not a button that could be tapped by reflex the way
 * a restart confirmation can. Run on the host, by the person who holds the
 * Telegram user id this grant records as `authorizedBy`.
 *
 * Usage:
 *   bun scripts/grant-watchdog-standing.ts <projectPath> <authorizedByTelegramUserId>
 *
 * Re-running for the same project replaces the existing grant (same actor,
 * same fingerprint) rather than creating a second one — see the unique index
 * in memory/db.ts's v51 migration.
 */

import { sql } from "../memory/db.ts";
import { issueStandingGrant, type ActionFingerprint } from "../utils/action-approval-grant.ts";

/**
 * The actor name a watchdog grant would be issued to.
 *
 * Declared here rather than imported from `tmux-watchdog.ts`, because the
 * watchdog has no knowledge of grants and must not acquire any: importing a
 * grant constant into it was how the withdrawn autonomous-restart path got its
 * foothold. The name lives with the thing that issues the grant, not with the
 * thing that would one day hold it.
 */
export const WATCHDOG_ACTOR = "tmux-watchdog";

async function main(): Promise<void> {
  const [projectPath, authorizedByRaw] = process.argv.slice(2);
  if (!projectPath || !authorizedByRaw) {
    console.error("usage: bun scripts/grant-watchdog-standing.ts <projectPath> <authorizedByTelegramUserId>");
    process.exit(1);
  }
  const authorizedBy = Number(authorizedByRaw);
  if (!Number.isInteger(authorizedBy) || authorizedBy <= 0) {
    console.error(`invalid authorizedBy: ${authorizedByRaw}`);
    process.exit(1);
  }
  if (!projectPath.startsWith("/")) {
    console.error(`projectPath must be absolute: ${projectPath}`);
    process.exit(1);
  }

  const fingerprint: ActionFingerprint = { half: "sessions", scope: projectPath, downtime: "brief" };
  const grant = await issueStandingGrant(sql, { fingerprint, actor: WATCHDOG_ACTOR, authorizedBy });
  console.log(`granted: ${WATCHDOG_ACTOR} may restart ${projectPath}'s sessions unattended (grant ${grant.grantId})`);
  await sql.end();
}

if (import.meta.main) {
  await main();
}

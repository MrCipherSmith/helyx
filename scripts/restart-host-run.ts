#!/usr/bin/env bun
/**
 * The detached entrypoint for a host-half restart.
 *
 * `restart-host.ts` holds the logic; this is the two lines of process that run
 * it somewhere the admin daemon's own restart cannot kill. It exists as a file
 * rather than a `-e` string because the sequence ends by restarting the service
 * that would otherwise be its parent, and debugging that through a shell quote
 * is not something anyone should have to do twice.
 *
 * Env:
 *   HELYX_RESTART_ADMIN=1  also restart helyx-admin.service at the end
 *
 * Log: whatever the caller redirected stdout to — /tmp/helyx-host-restart.log.
 */

import { resolve } from "path";
import { restartHostHalf } from "./restart-host.ts";
import { finishRestart } from "./restart-finish.ts";

const BOT_DIR = resolve(import.meta.dir, "..");
const CLI = resolve(BOT_DIR, "cli.ts");

async function runShell(cmd: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bash", "-c", cmd], { cwd: BOT_DIR, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { ok: proc.exitCode === 0, output: (stdout + stderr).trim() };
}

let result: Awaited<ReturnType<typeof restartHostHalf>>;
// Assumed failed until the work says otherwise, so the row records what
// happened rather than what was hoped: a bounce that hit its timeout, or a step
// that threw, used to close the row as `done` like any success. The only
// evidence left was a log file somebody had to think to open. Raised in review.
let ok = false;
try {
  result = await restartHostHalf(runShell, {
    botDir: BOT_DIR,
    bunBin: Bun.which("bun") ?? process.execPath,
    cli: CLI,
    restartAdminDaemon: process.env.HELYX_RESTART_ADMIN === "1",
  });
  ok = result.ok;
} finally {
  // In a `finally`, and before the exit below: a restart that threw halfway
  // must not hold the lease for the whole expiry, because the operator's next
  // move after a failed restart is to try again.
  await finishRestart(Number(process.env.HELYX_RESTART_ROW), ok ? "done" : "error");
}

console.log(`[host-restart] ${result.ok ? "ok" : "FAILED"}\n${result.summary}`);
process.exit(result.ok ? 0 : 1);

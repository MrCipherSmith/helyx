/**
 * Registering — and un-registering — helyx's Stop hook in Claude Code's global
 * settings.
 *
 * Both decisions here write to `~/.claude/settings.json`, a file this project
 * does not own and shares with everything else the user runs. That is why they
 * are extracted and tested: the cost of a mistake lands outside the project.
 *
 * Filesystem access is passed in rather than performed here, so the tests
 * exercise the real logic without touching a real settings file.
 */

/**
 * Why this checkout must not register a hook, or `null` if it may.
 *
 * A registration outlives the checkout that wrote it. From a temporary
 * directory or a linked worktree that means a permanent entry in the user's
 * global settings pointing at a script that no longer exists — which is what
 * `pruneStaleStopHooks` then has to clean up.
 *
 * Both the resolved temp directory and a literal `/tmp/` prefix are checked.
 * They are separate rules on a host where `TMPDIR` points somewhere else, and
 * the second one is deliberate rather than redundant.
 */
export function classifyCheckout(input: {
  botDir: string;
  tmpDir: string;
  gitPathIsFile: boolean;
}): string | null {
  const { botDir, tmpDir, gitPathIsFile } = input;
  if (botDir === tmpDir || botDir.startsWith(`${tmpDir}/`) || botDir.startsWith("/tmp/")) {
    return "temporary directory";
  }
  // A linked worktree has .git as a file pointing at the real gitdir; the main
  // checkout has it as a directory.
  if (gitPathIsFile) return "git worktree";
  return null;
}

/**
 * Drop registrations of this hook whose script no longer exists on disk.
 *
 * Mutates `stop` in place and returns how many hooks were removed. In place
 * because the caller writes the same object back out to settings.json —
 * returning a copy would leave the file unchanged and the stale hooks in it.
 *
 * Only entries whose command ends in `hookSuffix` are considered; every other
 * hook in the user's settings belongs to something else and is left alone. An
 * entry whose hooks all go is removed rather than left as an empty shell.
 *
 * @param hookSuffix path suffix identifying this project's hook, e.g. `/scripts/stop-hook.sh`
 * @param exists     existence predicate; production passes `existsSync`
 */
export function pruneStaleStopHooks(
  stop: Array<{ hooks?: Array<{ command?: unknown }> }>,
  hookSuffix: string,
  exists: (path: string) => boolean,
): number {
  let removed = 0;
  // Reverse, because an entry can be spliced out while iterating.
  for (let i = stop.length - 1; i >= 0; i--) {
    const entry = stop[i];
    if (!Array.isArray(entry?.hooks)) continue;
    const kept = entry.hooks.filter((h) => {
      const cmd = typeof h?.command === "string" ? h.command : "";
      if (!cmd.endsWith(hookSuffix)) return true;
      if (exists(cmd)) return true;
      removed++;
      return false;
    });
    if (kept.length === entry.hooks.length) continue;
    if (kept.length === 0) stop.splice(i, 1);
    else entry.hooks = kept;
  }
  return removed;
}

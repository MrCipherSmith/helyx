/**
 * Deciding which tmux windows a `helyx up` still has to start.
 *
 * This lived inline in cli.ts and got it wrong: `tmux has-session -t sess:name`
 * resolves the window by *prefix*, so a project named "goodai" matched the
 * existing "goodai-base" window and was reported as already running while
 * nothing had started it. The comparison is exact here, and it is separated
 * from the shell calls so it can be tested without a tmux server.
 */

export interface WindowProject {
  name: string;
  path: string;
}

/** tmux windows are named after the project. */
export function windowName(p: WindowProject): string {
  return p.name;
}

/**
 * Parse the output of `tmux list-windows -F '#{window_name}'`.
 *
 * Blank lines and surrounding whitespace are dropped: an empty session prints
 * nothing, and a trailing newline would otherwise register as a window named
 * "" that matches nothing and hides nothing.
 */
export function parseWindowNames(listOutput: string): Set<string> {
  return new Set(
    listOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Split projects by whether their window already exists.
 *
 * Order is preserved in both halves so the caller's console output follows the
 * order projects were configured in.
 */
export function partitionByWindow<T extends WindowProject>(
  projects: readonly T[],
  existingWindows: ReadonlySet<string>,
): { running: T[]; toStart: T[] } {
  const running: T[] = [];
  const toStart: T[] = [];
  for (const p of projects) {
    (existingWindows.has(windowName(p)) ? running : toStart).push(p);
  }
  return { running, toStart };
}

import { describe, test, expect } from "bun:test";
import { classifyCheckout, pruneStaleStopHooks } from "../../utils/stop-hook.ts";

/**
 * Both decisions here write to ~/.claude/settings.json — a file helyx does not
 * own and shares with everything else the user runs. Tested with the
 * filesystem passed in, so the array surgery is exercised without touching a
 * real settings file.
 */

const HOOK = "/scripts/save-session-facts.sh";
const hook = (command: string) => ({ command });
const entry = (...commands: string[]) => ({ hooks: commands.map(hook) });

describe("classifyCheckout", () => {
  test("a checkout inside the temp directory is refused", () => {
    expect(classifyCheckout({
      botDir: "/tmp/build-123/helyx",
      tmpDir: "/tmp",
      gitPathIsFile: false,
    })).toBe("temporary directory");
  });

  test("the temp directory itself is refused", () => {
    expect(classifyCheckout({ botDir: "/tmp", tmpDir: "/tmp", gitPathIsFile: false }))
      .toBe("temporary directory");
  });

  test("a literal /tmp/ path is refused even when TMPDIR points elsewhere", () => {
    // Two independent rules, not one redundant pair.
    expect(classifyCheckout({
      botDir: "/tmp/helyx",
      tmpDir: "/var/folders/xy/T",
      gitPathIsFile: false,
    })).toBe("temporary directory");
  });

  test("a path that merely starts with the tmpdir name is allowed", () => {
    // /tmpfoo is not inside /tmp. The separator in the prefix check is what
    // keeps this from being a false positive.
    expect(classifyCheckout({
      botDir: "/tmpfoo/helyx",
      tmpDir: "/tmp",
      gitPathIsFile: false,
    })).toBeNull();
  });

  test("a git worktree is refused", () => {
    // A linked worktree has .git as a file; the main checkout has a directory.
    expect(classifyCheckout({
      botDir: "/home/dev/helyx-wt",
      tmpDir: "/tmp",
      gitPathIsFile: true,
    })).toBe("git worktree");
  });

  test("a normal checkout is allowed", () => {
    expect(classifyCheckout({
      botDir: "/home/dev/helyx",
      tmpDir: "/tmp",
      gitPathIsFile: false,
    })).toBeNull();
  });

  test("the temp rule wins over the worktree rule", () => {
    expect(classifyCheckout({
      botDir: "/tmp/wt/helyx",
      tmpDir: "/tmp",
      gitPathIsFile: true,
    })).toBe("temporary directory");
  });
});

describe("pruneStaleStopHooks", () => {
  const gone = () => false;
  const present = () => true;

  test("removes a hook whose script is missing", () => {
    const stop = [entry(`/old/checkout${HOOK}`)];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(1);
    expect(stop).toEqual([]);
  });

  test("keeps a hook whose script exists", () => {
    const stop = [entry(`/home/dev/helyx${HOOK}`)];
    expect(pruneStaleStopHooks(stop, HOOK, present)).toBe(0);
    expect(stop).toHaveLength(1);
  });

  test("leaves other projects' hooks alone, even when their scripts are gone", () => {
    const stop = [entry("/somewhere/other-tool/hook.sh")];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(0);
    expect(stop).toEqual([entry("/somewhere/other-tool/hook.sh")]);
  });

  test("prunes within an entry and keeps the survivors", () => {
    const stop = [entry(`/gone${HOOK}`, "/other/tool.sh")];
    const exists = (p: string) => !p.startsWith("/gone");
    expect(pruneStaleStopHooks(stop, HOOK, exists)).toBe(1);
    expect(stop).toHaveLength(1);
    expect(stop[0]!.hooks).toEqual([hook("/other/tool.sh")]);
  });

  test("an entry left with no hooks is removed, not left empty", () => {
    const stop = [entry(`/gone${HOOK}`), entry("/other/tool.sh")];
    const exists = (p: string) => !p.startsWith("/gone");
    expect(pruneStaleStopHooks(stop, HOOK, exists)).toBe(1);
    expect(stop).toEqual([entry("/other/tool.sh")]);
  });

  test("removes several stale entries in one pass", () => {
    const stop = [entry(`/a${HOOK}`), entry(`/b${HOOK}`), entry(`/c${HOOK}`)];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(3);
    expect(stop).toEqual([]);
  });

  test("splicing during the reverse walk does not skip an entry", () => {
    // The loop runs backwards precisely so a splice cannot shift an unvisited
    // index. Two adjacent stale entries would expose a forward loop.
    const stop = [entry("/keep/tool.sh"), entry(`/a${HOOK}`), entry(`/b${HOOK}`)];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(2);
    expect(stop).toEqual([entry("/keep/tool.sh")]);
  });

  test("mutates the array it is given rather than returning a copy", () => {
    // The caller writes this same object back to settings.json. A copy would
    // leave the file unchanged and the stale hooks in it.
    const stop = [entry(`/gone${HOOK}`)];
    const same = stop;
    pruneStaleStopHooks(stop, HOOK, gone);
    expect(same).toBe(stop);
    expect(same).toHaveLength(0);
  });

  test("entries without a hooks array are skipped, not crashed on", () => {
    const stop = [{} as { hooks?: Array<{ command?: unknown }> }, entry(`/gone${HOOK}`)];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(1);
    expect(stop).toHaveLength(1);
  });

  test("a hook with a non-string command is left alone", () => {
    const stop = [{ hooks: [{ command: 42 }] }];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(0);
    expect(stop).toHaveLength(1);
  });

  test("an empty settings list is a no-op", () => {
    const stop: Array<{ hooks?: Array<{ command?: unknown }> }> = [];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(0);
    expect(stop).toEqual([]);
  });

  test("the suffix must match at the end, not anywhere", () => {
    // A path containing the suffix mid-string belongs to something else.
    const stop = [entry(`/x${HOOK}/nested/other.sh`)];
    expect(pruneStaleStopHooks(stop, HOOK, gone)).toBe(0);
    expect(stop).toHaveLength(1);
  });
});

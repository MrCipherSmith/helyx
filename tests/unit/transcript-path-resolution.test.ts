/**
 * The path the hook posts, and the path this process can open.
 *
 * A Claude Code session runs on the host and reports
 * `/home/<user>/.claude/projects/<slug>/<id>.jsonl`. The bot reading that
 * report runs in a container where the same directory is mounted somewhere
 * else and `/home/<user>` does not exist at all. Both consumers of the hook
 * took the path literally, so neither had ever succeeded in a container: one
 * logged `file not found` 4136 times, the other fails silently by design and
 * left no trace.
 *
 * These drive the real resolver and the real session-end extractor.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localTranscriptPath } from "../../utils/transcript-locate.ts";
import { extractFactsFromTranscript } from "../../memory/summarizer.ts";
import { logger } from "../../logger.ts";

const HOST_PATH = "/home/altsay/.claude/projects/-home-altsay-bots-helyx/abc.jsonl";
const ROOT = "/host-claude-config";

describe("localTranscriptPath", () => {
  test("a path that exists is returned untouched", () => {
    // The host case, and every test written before containers were considered.
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === HOST_PATH;
    };

    expect(localTranscriptPath(HOST_PATH, ROOT, exists)).toBe(HOST_PATH);
    expect(seen).toEqual([HOST_PATH]); // no second candidate was even considered
  });

  test("a host path is re-rooted at the config root when only that exists", () => {
    const container = `${ROOT}/projects/-home-altsay-bots-helyx/abc.jsonl`;
    const exists = (p: string) => p === container;

    expect(localTranscriptPath(HOST_PATH, ROOT, exists)).toBe(container);
  });

  test("only the segment after /.claude/ is carried over", () => {
    // The incoming path was validated by the caller and the derived one is not
    // validated again, so what is carried has to be the narrow part.
    const captured: string[] = [];
    localTranscriptPath("/root/.claude/projects/x/y.jsonl", "/mnt/cfg", (p) => {
      captured.push(p);
      return false;
    });

    expect(captured[1]).toBe("/mnt/cfg/projects/x/y.jsonl");
  });

  test("a carried segment containing .. is rejected, not resolved", () => {
    const evil = "/home/altsay/.claude/../../etc/passwd";

    expect(localTranscriptPath(evil, ROOT, () => false)).toBeNull();
  });

  test("a carried segment that looks absolute still lands under the root", () => {
    // Raised in two review rounds as an escape to /etc/passwd. It never was —
    // `join` treats a leading-slash segment as relative — but the segment is
    // now stripped before joining, so containment no longer depends on knowing
    // that `join` and `resolve` differ. This asserts the result either way.
    const captured: string[] = [];
    localTranscriptPath("/home/altsay/.claude//etc/passwd", "/host-claude-config", (p) => {
      captured.push(p);
      return false;
    });

    expect(captured[1]).toBe("/host-claude-config/etc/passwd");
  });

  test("null when neither candidate exists, and when there is no .claude segment", () => {
    expect(localTranscriptPath(HOST_PATH, ROOT, () => false)).toBeNull();
    expect(localTranscriptPath("/tmp/somewhere/else.jsonl", ROOT, () => false)).toBeNull();
    expect(localTranscriptPath("", ROOT, () => false)).toBeNull();
  });
});

describe("extractFactsFromTranscript resolves before it gives up", () => {
  const dirs: string[] = [];
  const originalRoot = process.env.HOST_CLAUDE_CONFIG;

  /** A config root with one transcript in it, as Claude Code would lay it out. */
  function configRoot(cwd: string, lines: string[]): { root: string; hostPath: string } {
    const root = mkdtempSync(join(tmpdir(), "helyx-claude-"));
    dirs.push(root);
    const slug = "-slug-for-" + cwd.replace(/\//g, "-");
    mkdirSync(join(root, "projects", slug), { recursive: true });
    const file = join(root, "projects", slug, "session.jsonl");
    writeFileSync(file, lines.join("\n"));
    process.env.HOST_CLAUDE_CONFIG = root;
    return { root, hostPath: `/home/nobody/.claude/projects/${slug}/session.jsonl` };
  }

  /** Two turns: enough to prove the file was read, too few to reach the model. */
  const twoTurns = (cwd: string) => [
    JSON.stringify({ type: "user", cwd, message: { content: "a question long enough to count" } }),
    JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "text", text: "an answer long enough to count" }] } }),
  ];

  function captureWarnings(): { warnings: unknown[]; restore: () => void } {
    const warnings: unknown[] = [];
    const real = logger.warn;
    (logger as { warn: unknown }).warn = (obj: unknown) => { warnings.push(obj); };
    return { warnings, restore: () => { (logger as { warn: unknown }).warn = real; } };
  }

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.HOST_CLAUDE_CONFIG;
    else process.env.HOST_CLAUDE_CONFIG = originalRoot;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("a transcript that exists only under the config root is read, not reported missing", async () => {
    const cwd = "/home/nobody/project";
    const { hostPath } = configRoot(cwd, twoTurns(cwd));
    const { warnings, restore } = captureWarnings();

    // Returns 0 because two turns is under the threshold — but reaching that
    // decision at all means the file was opened, which is the whole point.
    const count = await extractFactsFromTranscript(hostPath, cwd);
    restore();

    expect(count).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("an unrecognisable path falls back to the transcript that declares this cwd", async () => {
    const cwd = "/home/nobody/other-project";
    configRoot(cwd, twoTurns(cwd));
    const { warnings, restore } = captureWarnings();

    // No `/.claude/` segment to re-root: only the scan can find this one, and
    // it matches on the cwd the transcript itself declares.
    const count = await extractFactsFromTranscript("/var/lib/elsewhere.jsonl", cwd);
    restore();

    expect(count).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("a path that cannot be resolved at all still warns and returns 0", async () => {
    const cwd = "/home/nobody/project";
    configRoot(cwd, twoTurns(cwd));
    const { warnings, restore } = captureWarnings();

    const count = await extractFactsFromTranscript("/var/lib/gone.jsonl", "/home/nobody/no-such-project");
    restore();

    expect(count).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

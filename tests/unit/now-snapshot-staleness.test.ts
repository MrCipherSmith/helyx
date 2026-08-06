/**
 * What `/now` is allowed to call a live session.
 *
 * `snapshotForProject` finds a transcript by the `cwd` it declares. Every other
 * caller of `resolveTranscript` also passes a staleness bound, because a match
 * that has not been written to in half a day is a session that finished, not
 * the one being asked about. This one did not — and a topic whose session is
 * stopped, never started, or mid-restart still has yesterday's transcript on
 * disk, so `/now` would read it and answer about work that ended days ago.
 *
 * Drives the real function against a real directory: the defect was in which
 * file gets opened, and a fixture that answered from memory would be testing
 * the fixture.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotForProject } from "../../bot/commands/now.ts";
import { TRANSCRIPT_STALE_MS } from "../../utils/transcript-monitor.ts";

const PROJECT = "/home/someone/bots/helyx";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helyx-now-"));
  mkdirSync(join(root, "projects"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A transcript for this project, aged as given. */
function transcript(name: string, ageMs: number): void {
  const dir = join(root, "projects", "slug");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  const lines = [
    { type: "system", cwd: PROJECT },
    { type: "assistant", cwd: PROJECT, message: { content: [{ type: "text", text: "работаю" }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

describe("the session /now reports on", () => {
  test("a transcript written just now is the session", async () => {
    transcript("live", 1_000);

    expect((await snapshotForProject(PROJECT, root)).found).toBe(true);
  });

  test("yesterday's transcript is a finished session, not this one", async () => {
    // The reported shape: the topic is mapped to a project whose session is not
    // running. Without the bound this answered `found: true` with real content
    // and a "silent for a while" badge — about a session that had already ended.
    transcript("yesterday", TRANSCRIPT_STALE_MS + 60_000);

    const snapshot = await snapshotForProject(PROJECT, root);

    expect(snapshot.found).toBe(false);
    expect(snapshot.lastLine).toBeNull();
  });

  test("no transcript at all is the same answer, not an error", async () => {
    expect((await snapshotForProject(PROJECT, root)).found).toBe(false);
  });
});

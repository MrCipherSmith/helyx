/**
 * The loop, not the decision.
 *
 * `utils/error-stream.ts` decides what is worth telling and is tested on its
 * own. None of that puts a single alert in front of the operator, and this
 * repository has been caught by that distinction before — a fix that passed its
 * own unit tests while changing nothing anyone could see.
 *
 * So these drive the real `checkErrorStream` and look at what came out.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkErrorStream, createErrorStreamReader, ERROR_STREAM_BLIND_AFTER, type ErrorStreamReader } from "../../scripts/supervisor.ts";
import { ErrorWindow, LEVEL_ERROR } from "../../utils/error-stream.ts";

const NOW = 1_700_000_000_000;

const line = (level: number, msg: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ level, time: NOW, pid: 1, msg, ...extra });

interface Harness {
  reader: ErrorStreamReader;
  alerts: Array<{ text: string; key: string }>;
  notes: string[];
  deps: Parameters<typeof checkErrorStream>[1];
}

/** A reader that hands over scripted batches, one per pass. */
function harness(batches: string[][], options: { fail?: boolean } = {}): Harness {
  const alerts: Array<{ text: string; key: string }> = [];
  const notes: string[] = [];
  let pass = 0;

  const reader: ErrorStreamReader = {
    window: new ErrorWindow({ errorThreshold: 3, windowMs: 60_000 }),
    failures: 0,
    read: async () => {
      if (options.fail) throw new Error("EACCES: permission denied");
      return batches[pass++] ?? [];
    },
  };

  return {
    reader,
    alerts,
    notes,
    deps: {
      alert: async (text: string, key: string) => { alerts.push({ text, key }); },
      note: (message: string) => { notes.push(message); },
      now: () => NOW,
    },
  };
}

describe("the reader over a real file", () => {
  const made: string[] = [];

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempLog(): string {
    const dir = mkdtempSync(join(tmpdir(), "helyx-errlog-"));
    made.push(dir);
    return join(dir, "bot.log");
  }

  test("a log that does not exist yet is silence, and its history is not replayed when it appears", async () => {
    // Raised in review as "the watcher stays blind for ever". The mechanism is
    // different and worse: TranscriptTail.atEnd does not throw on a missing
    // file, it starts at offset 0 — so the first read after the file appeared
    // would have replayed the whole of it. On this host that is 4217 old
    // warnings arriving as though they had just happened.
    const path = tempLog();
    const reader = createErrorStreamReader(path);

    expect(await reader.read()).toEqual([]);

    writeFileSync(path, [line(LEVEL_ERROR, "old news"), line(LEVEL_ERROR, "older news")].join("\n") + "\n");

    // The file exists now: the tail opens at its end, so nothing already in it
    // is news.
    expect(await reader.read()).toEqual([]);

    appendFileSync(path, line(LEVEL_ERROR, "this just happened") + "\n");

    const fresh = await reader.read();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toContain("this just happened");
  });
});

describe("checkErrorStream", () => {
  test("a new error reaches the operator, named and keyed", async () => {
    const h = harness([[line(LEVEL_ERROR, "tts: Yandex error", { status: 401 })]]);

    await checkErrorStream(h.reader, h.deps);

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.key).toBe("error_stream:tts: Yandex error");
    expect(h.alerts[0]!.text).toContain("tts: Yandex error");
    expect(h.alerts[0]!.text).toContain("Новая ошибка");
    // The context that says why, not the whole line.
    expect(h.alerts[0]!.text).toContain("401");
  });

  test("a flood says how many, and over what window", async () => {
    const h = harness([
      [line(LEVEL_ERROR, "db: query failed")],
      [line(LEVEL_ERROR, "db: query failed"), line(LEVEL_ERROR, "db: query failed")],
    ]);

    await checkErrorStream(h.reader, h.deps); // novel
    await checkErrorStream(h.reader, h.deps); // crosses the threshold

    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]!.text).toContain("3 раз за 1 мин");
  });

  test("a pass over an unchanged file says nothing", async () => {
    const h = harness([[line(LEVEL_ERROR, "db: query failed")], []]);

    await checkErrorStream(h.reader, h.deps);
    const afterFirst = h.alerts.length;
    await checkErrorStream(h.reader, h.deps);

    expect(afterFirst).toBe(1);
    expect(h.alerts).toHaveLength(1);
  });

  test("info chatter is not an alert", async () => {
    const h = harness([[line(30, "perf"), line(30, "saved summary and facts")]]);

    await checkErrorStream(h.reader, h.deps);

    expect(h.alerts).toEqual([]);
  });

  test("a watcher that cannot read the log says so, once", async () => {
    // The failure mode this whole loop exists to remove is a monitor that stops
    // working quietly. Its own blindness is not allowed to be quiet either.
    const h = harness([], { fail: true });

    for (let i = 0; i < ERROR_STREAM_BLIND_AFTER + 2; i++) {
      await checkErrorStream(h.reader, h.deps);
    }

    expect(h.notes.length).toBe(ERROR_STREAM_BLIND_AFTER + 2);
    expect(h.notes[0]).toContain("permission denied");
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.key).toBe("error_stream:unreadable");
  });

  test("a read failure never throws into the caller", async () => {
    const h = harness([], { fail: true });

    // The loop is scheduled with `.catch(() => {})`, so a throw here would be
    // swallowed and the watcher would die silently — the exact shape of D2.
    await expect(checkErrorStream(h.reader, h.deps)).resolves.toBeUndefined();
  });
});

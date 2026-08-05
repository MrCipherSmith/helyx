/**
 * The two rules that decide what the operator hears about the bot's own log.
 *
 * Volume catches the case that was actually there: 4136 identical warnings,
 * nothing new about any of them, and nobody told. Novelty catches the one
 * volume cannot: an error that starts today and stays quiet, which is how a
 * 401 on every voice message went weeks without being mentioned.
 *
 * The lines below are copied out of `logs/bot.log` rather than invented, so a
 * change to what the bot writes breaks these rather than passing them.
 */

import { describe, test, expect } from "bun:test";
import {
  parseLogEntry,
  ErrorWindow,
  LEVEL_ERROR,
  LEVEL_WARN,
} from "../../utils/error-stream.ts";

/** Verbatim from logs/bot.log:85. */
const REAL_WARNING =
  '{"level":40,"time":1775876143981,"pid":1,"hostname":"ba99f58abaad","transcriptPath":"/home/altsay/.claude/projects/-home-altsay-bots-helyx/4e30e5bd-6d49-4d1c-b3a0-9b4d338e9e4b.jsonl","msg":"extractFactsFromTranscript: file not found"}';

/** Verbatim from logs/bot.log, the Yandex 401 that ran for weeks unreported. */
const REAL_ERROR =
  '{"level":50,"time":1785933375219,"pid":1,"hostname":"cc4bf9eacf41","status":401,"err":"{\\"error_code\\":\\"UNAUTHORIZED\\"}","msg":"tts: Yandex error"}';

const at = (level: number, time: number, msg: string) =>
  JSON.stringify({ level, time, pid: 1, msg });

describe("parseLogEntry", () => {
  test("reads a real warning line", () => {
    const entry = parseLogEntry(REAL_WARNING);

    expect(entry).not.toBeNull();
    expect(entry!.level).toBe(LEVEL_WARN);
    expect(entry!.time).toBe(1775876143981);
    expect(entry!.msg).toBe("extractFactsFromTranscript: file not found");
    // The context worth quoting back, not the whole line.
    expect(entry!.detail).toContain("/.claude/projects/");
  });

  test("reads a real error line and keeps what says why", () => {
    const entry = parseLogEntry(REAL_ERROR);

    expect(entry!.level).toBe(LEVEL_ERROR);
    expect(entry!.msg).toBe("tts: Yandex error");
    expect(entry!.detail).toContain("UNAUTHORIZED");
  });

  test("null for what is not a log entry", () => {
    // All three happen: a half-written line caught mid-read, something else
    // appending to the file, and a pino line with no message at all.
    expect(parseLogEntry('{"level":50,"time":17758761439')).toBeNull();
    expect(parseLogEntry("bun install v1.3.11")).toBeNull();
    expect(parseLogEntry('{"level":50,"time":1,"pid":1}')).toBeNull();
    expect(parseLogEntry("")).toBeNull();
  });
});

describe("volume", () => {
  test("one alert when a message crosses the threshold, and not again inside the window", () => {
    const window = new ErrorWindow({ errorThreshold: 3, windowMs: 60_000 });
    const now = 1_000_000;
    // Seed the message so the novelty rule is not what fires here.
    window.observe([at(LEVEL_ERROR, now - 50_000, "db: query failed")], now);

    const first = window.observe(
      [
        at(LEVEL_ERROR, now - 2_000, "db: query failed"),
        at(LEVEL_ERROR, now - 1_000, "db: query failed"),
      ],
      now,
    );
    const second = window.observe([at(LEVEL_ERROR, now, "db: query failed")], now);

    expect(first).toHaveLength(1);
    expect(first[0]!.reason).toBe("volume");
    expect(first[0]!.count).toBe(3);
    expect(second).toEqual([]);
  });

  test("occurrences that aged out stop counting", () => {
    const window = new ErrorWindow({ errorThreshold: 3, windowMs: 60_000 });
    const now = 1_000_000;
    window.observe([at(LEVEL_ERROR, now - 500_000, "db: query failed")], now - 400_000);

    // Two inside the window and one long past it: a trickle under the rate
    // never accumulates into an alert.
    const alerts = window.observe(
      [at(LEVEL_ERROR, now - 30_000, "db: query failed"), at(LEVEL_ERROR, now, "db: query failed")],
      now,
    );

    expect(alerts).toEqual([]);
  });

  test("warnings have their own, higher bar", () => {
    const window = new ErrorWindow({ errorThreshold: 3, warnThreshold: 5, windowMs: 60_000 });
    const now = 1_000_000;
    const four = Array.from({ length: 4 }, (_, i) => at(LEVEL_WARN, now - i, "extractFactsFromTranscript: file not found"));

    expect(window.observe(four, now)).toEqual([]);

    const fifth = window.observe([at(LEVEL_WARN, now, "extractFactsFromTranscript: file not found")], now);

    expect(fifth).toHaveLength(1);
    expect(fifth[0]!.count).toBe(5);
    expect(fifth[0]!.level).toBe(LEVEL_WARN);
  });

  test("info is not watched at all", () => {
    const window = new ErrorWindow({ errorThreshold: 2, windowMs: 60_000 });
    const now = 1_000_000;
    const chatter = Array.from({ length: 50 }, (_, i) => at(30, now - i, "perf"));

    expect(window.observe(chatter, now)).toEqual([]);
  });
});

describe("novelty", () => {
  test("an error never seen before is reported on its first occurrence", () => {
    // The threshold is 10 and this fires on 1: a leak does not have to be loud.
    const window = new ErrorWindow({ errorThreshold: 10, windowMs: 60_000 });

    const alerts = window.observe([REAL_ERROR], 1785933375219);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toBe("novel");
    expect(alerts[0]!.msg).toBe("tts: Yandex error");
    expect(alerts[0]!.count).toBe(1);
    expect(alerts[0]!.detail).toContain("UNAUTHORIZED");
  });

  test("the same error does not claim novelty twice", () => {
    const window = new ErrorWindow({ errorThreshold: 10, windowMs: 60_000 });
    const now = 1785933375219;
    window.observe([REAL_ERROR], now);

    const again = window.observe([at(LEVEL_ERROR, now + 1_000, "tts: Yandex error")], now + 1_000);

    expect(again).toEqual([]);
  });

  test("a message unseen for longer than the memory is new again", () => {
    const window = new ErrorWindow({ errorThreshold: 10, noveltyMs: 1_000, windowMs: 60_000 });
    const now = 1_000_000;
    window.observe([at(LEVEL_ERROR, now, "db: query failed")], now);

    const later = window.observe([at(LEVEL_ERROR, now + 5_000, "db: query failed")], now + 5_000);

    expect(later).toHaveLength(1);
    expect(later[0]!.reason).toBe("novel");
  });

  test("having been reported as new does not exempt it from being reported as a flood", () => {
    // The two rules answer different questions. "This error exists" was said
    // once; "it is now happening constantly" is a different sentence and the
    // operator is owed it.
    const window = new ErrorWindow({ errorThreshold: 3, windowMs: 60_000 });
    const now = 1_000_000;

    const first = window.observe([at(LEVEL_ERROR, now - 2, "db: query failed")], now);
    const rest = window.observe(
      [at(LEVEL_ERROR, now - 1, "db: query failed"), at(LEVEL_ERROR, now, "db: query failed")],
      now,
    );

    expect(first[0]!.reason).toBe("novel");
    expect(rest).toHaveLength(1);
    expect(rest[0]!.reason).toBe("volume");
    expect(rest[0]!.count).toBe(3);
  });

  test("a new warning is not novel — only errors are", () => {
    // Otherwise every first warning of a new kind pages the operator, and
    // warnings are where the noise lives.
    const window = new ErrorWindow({ warnThreshold: 100, windowMs: 60_000 });

    expect(window.observe([REAL_WARNING], 1775876143981)).toEqual([]);
  });
});

describe("what the alert carries", () => {
  test("the message, the count, the window and when it started", () => {
    // Asserted on the object rather than on rendered text: the rendering is the
    // supervisor's, and an alert that only exists as a string cannot be tested
    // by anything but a string comparison.
    const window = new ErrorWindow({ errorThreshold: 2, windowMs: 60_000 });
    const now = 1_000_000;
    window.observe([at(LEVEL_ERROR, now - 40_000, "db: query failed")], now - 40_000);

    const alerts = window.observe([at(LEVEL_ERROR, now, "db: query failed")], now);

    expect(alerts[0]).toMatchObject({
      msg: "db: query failed",
      level: LEVEL_ERROR,
      count: 2,
      firstAt: now - 40_000,
      windowMs: 60_000,
      reason: "volume",
    });
  });
});

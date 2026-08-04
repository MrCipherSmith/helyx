/**
 * The numbers the operator reads, and the argument they asked with.
 *
 * `/permission_stats -5` parsed to -5, survived `Math.min(-5, 365)` and
 * reached `make_interval(days => -5)` — a window ending before it begins. The
 * operator was told there were no permission requests in the last -5 days, for
 * a database full of them: wrong, confident and quiet.
 */

import { describe, test, expect } from "bun:test";
import {
  parseDaysArg,
  percentOf,
  histogramBar,
  DEFAULT_DAYS,
  MAX_DAYS,
  BAR_WIDTH,
} from "../../utils/admin-format.ts";

describe("the window asked for", () => {
  test("a plain number is taken", () => {
    expect(parseDaysArg("7")).toBe(7);
    expect(parseDaysArg(" 14 ")).toBe(14);
  });

  test("nothing asked for is the default", () => {
    expect(parseDaysArg("")).toBe(DEFAULT_DAYS);
    expect(parseDaysArg("   ")).toBe(DEFAULT_DAYS);
    expect(parseDaysArg(undefined)).toBe(DEFAULT_DAYS);
    expect(parseDaysArg(null)).toBe(DEFAULT_DAYS);
  });

  test("nonsense is the default rather than a database error", () => {
    expect(parseDaysArg("неделя")).toBe(DEFAULT_DAYS);
    expect(parseDaysArg("NaN")).toBe(DEFAULT_DAYS);
    expect(parseDaysArg("Infinity")).toBe(DEFAULT_DAYS);
  });

  test("a negative window is the default, not a window that ends before it starts", () => {
    // The bug this exists for. A negative number is truthy, so the old falsy
    // check waved it through and the query returned nothing for a full table.
    expect(parseDaysArg("-5")).toBe(DEFAULT_DAYS);
    expect(parseDaysArg("-0.5")).toBe(DEFAULT_DAYS);
    expect(parseDaysArg("0")).toBe(DEFAULT_DAYS);
  });

  test("the cap holds, and the boundary is where it says", () => {
    // Both sides, so the clamp cannot drift into rejecting the largest window
    // anyone actually asks for.
    expect(parseDaysArg(String(MAX_DAYS))).toBe(MAX_DAYS);
    expect(parseDaysArg(String(MAX_DAYS + 1))).toBe(MAX_DAYS);
    expect(parseDaysArg("100000")).toBe(MAX_DAYS);
  });

  test("a fraction becomes whole days", () => {
    // `make_interval(days => 1.5)` is not an error and not a day and a half
    // either; it is rounded somewhere the operator cannot see.
    expect(parseDaysArg("1.9")).toBe(1);
    expect(parseDaysArg("7.2")).toBe(7);
  });
});

describe("the percentages", () => {
  test("are what they say", () => {
    expect(percentOf(1, 4)).toBe("25%");
    expect(percentOf(3, 3)).toBe("100%");
    expect(percentOf(0, 10)).toBe("0%");
  });

  test("an empty table does not divide by zero", () => {
    // The caller reaches this with whatever the database returned, and an
    // empty table is an ordinary Tuesday.
    expect(percentOf(0, 0)).toBe("0%");
    expect(percentOf(5, 0)).toBe("0%");
    expect(percentOf(1, -1)).toBe("0%");
  });

  test("rounding is to whole percent", () => {
    expect(percentOf(1, 3)).toBe("33%");
    expect(percentOf(2, 3)).toBe("67%");
  });
});

describe("the bars", () => {
  test("the largest row fills the bar", () => {
    expect(histogramBar(10, 10)).toBe("█".repeat(BAR_WIDTH));
  });

  test("and the others are proportional to it", () => {
    const half = histogramBar(5, 10);
    expect(half.startsWith("████")).toBe(true);
    expect(half).toHaveLength(BAR_WIDTH);
  });

  test("every bar is the same width, whatever it holds", () => {
    // Ragged widths and the column stops lining up, which is the only thing
    // the bars are for.
    for (const value of [0, 1, 5, 9, 10]) {
      expect([value, histogramBar(value, 10).length]).toEqual([value, BAR_WIDTH]);
    }
  });

  test("a largest of zero draws nothing rather than throwing", () => {
    // `"█".repeat(NaN)` is "" but `repeat(-1)` throws, and the difference
    // between those two is one division nobody guarded.
    expect(histogramBar(0, 0)).toBe("░".repeat(BAR_WIDTH));
    expect(histogramBar(5, 0)).toBe("░".repeat(BAR_WIDTH));
  });

  test("a row larger than the largest cannot overflow the bar", () => {
    // Should not happen — the rows are ordered — but a bar longer than its
    // width wraps in Telegram, and "should not happen" is not a mechanism.
    expect(histogramBar(20, 10)).toHaveLength(BAR_WIDTH);
    expect(histogramBar(20, 10)).toBe("█".repeat(BAR_WIDTH));
  });
});

/**
 * Regression test for F-007: buildResultText's overflow suffix used to be a
 * double-quoted string containing `${events.length - 50}`, so the
 * interpolation was never evaluated and the literal placeholder text was
 * sent to the user instead of the actual overflow count. Fixed by switching
 * the inner string to a template literal (bot/commands/tmux-log.ts:119).
 */

import { describe, test, expect } from "bun:test";
import { buildResultText, type LogEvent } from "../../bot/commands/tmux-log.ts";

function event(i: number): LogEvent {
  return { ts: "2026-08-31T12:00:00.000Z", event: "snapshot", session: "bots", window: `w${i}` };
}

describe("buildResultText's overflow suffix", () => {
  test("interpolates the real overflow count when there are more than 50 events", () => {
    const events = Array.from({ length: 63 }, (_, i) => event(i));
    const text = buildResultText(events, "1 час");

    // The bug produced this exact literal string instead of the number.
    expect(text).not.toContain("${events.length - 50}");
    expect(text).toContain("…ещё 13 событий");
  });

  test("omits the overflow suffix entirely at or under 50 events", () => {
    const events = Array.from({ length: 50 }, (_, i) => event(i));
    const text = buildResultText(events, "1 час");

    expect(text).not.toContain("…ещё");
    expect(text).not.toContain("${events.length - 50}");
  });

  test("reports no-events text when the list is empty", () => {
    const text = buildResultText([], "24 часа");
    expect(text).toContain("Нет событий за указанный период");
  });
});

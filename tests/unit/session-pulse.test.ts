/**
 * The line that says a session is fine, before any alarm has to guess.
 *
 * The supervisor speaks only when something is wrong, so a long piece of work is
 * indistinguishable from a stall until the five-minute alarm decides — and the
 * alarm's whole question is whether silence means trouble. The pulse answers it
 * from the other side: tokens in and out, how long it has been at it, how full
 * its context is, and what it is doing.
 *
 * The risk it carries is that it is a message nobody asked for, arriving
 * forever. That is how a monitoring feature becomes noise, then becomes muted,
 * and takes the alarms sitting next to it down with it — so most of this file is
 * about the cases where it says nothing at all.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionPulse, shortTokens, shortElapsed, type PulseObservation } from "../../services/session-pulse.ts";
import {
  checkContextPressure,
  sendSessionPulse,
  resetContextHighWater,
  resetSessionPulse,
  PULSE_INTERVAL_MS,
} from "../../scripts/supervisor.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";

const T0 = 1_800_000_000_000;

function observation(overrides: Partial<PulseObservation> = {}): PulseObservation {
  return {
    sessionId: 7,
    project: "helyx",
    inputTokens: 611_571,
    outputTokens: 3_900,
    window: 1_000_000,
    busy: true,
    paneSpinner: false,
    turnStartedAt: T0 - 260_000,
    activity: "● Bash: bun test tests/unit",
    limited: false,
    pane: null,
    at: T0,
    ...overrides,
  };
}

/** A pane whose spinner is on frame `glyph` and whose output is `tail`. */
function pane(glyph: string, seconds: number, ...tail: string[]): string {
  return [
    "● Bash(bun test tests/unit)",
    ...tail,
    `${glyph} Thinking… (${seconds}s · ↑ 1.2k tokens · esc to interrupt)`,
  ].join("\n");
}

describe("what one line carries", () => {
  test("the project, both token counts, the context, the elapsed and the work", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation());

    const [line] = pulse.pulse(T0);

    expect(line?.text).toContain("helyx");
    expect(line?.text).toContain("↑ 611.6k");
    expect(line?.text).toContain("↓ 3.9k");
    expect(line?.text).toContain("61% от 1.0M");
    expect(line?.text).toContain("4m");
    expect(line?.text).toContain("bun test");
    expect(line?.state).toBe("working");
  });

  test("the activity line is escaped — it is another program's text", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ activity: "● Bash: grep <foo> & bar" }));

    expect(pulse.pulse(T0)[0]?.text).toContain("&lt;foo&gt; &amp; bar");
  });

  test("a missing count is a question mark, not a zero", () => {
    // Zero is a measurement and "not measured yet" is not one. A transcript
    // with no usage in its tail has not said the session used nothing.
    const pulse = new SessionPulse();
    pulse.observe(observation({ outputTokens: null }));

    expect(pulse.pulse(T0)[0]?.text).toContain("↓ ?");
  });
});

describe("who is in it", () => {
  test("an idle session is not", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ busy: false, paneSpinner: false }));

    expect(pulse.pulse(T0)).toEqual([]);
  });

  test("a session working in its pane is, with no Telegram turn in sight", () => {
    // The blind spot the widened hang query is about, from the other side: a
    // turn typed into tmux has no status message and is a working session all
    // the same.
    const pulse = new SessionPulse();
    pulse.observe(observation({ busy: false, paneSpinner: true, turnStartedAt: null }));

    const [line] = pulse.pulse(T0);
    expect(line?.project).toBe("helyx");
  });

  test("a limited session is not — that is its own state and its own report", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ limited: true }));

    expect(pulse.pulse(T0)).toEqual([]);
  });

  test("a session with no numbers yet has nothing to say", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ inputTokens: null, outputTokens: null }));

    expect(pulse.pulse(T0)).toEqual([]);
  });

  test("elapsed falls back to when the session was first seen working", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ busy: false, paneSpinner: true, turnStartedAt: null, at: T0 }));
    pulse.observe(observation({ busy: false, paneSpinner: true, turnStartedAt: null, at: T0 + 120_000, inputTokens: 700_000 }));

    expect(pulse.pulse(T0 + 180_000)[0]?.text).toContain("3m");
  });
});

describe("two pulses that say the same thing", () => {
  test("the second one is a session that has stopped progressing", () => {
    // The numbers moving is the whole proof that the session is thinking. Two
    // identical readings a pulse apart is a third state beside hung and
    // limited, and it is reported as itself.
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0 }));
    expect(pulse.pulse(T0)[0]?.state).toBe("working");

    pulse.observe(observation({ at: T0 + PULSE_INTERVAL_MS }));
    const [line] = pulse.pulse(T0 + PULSE_INTERVAL_MS);

    expect(line?.state).toBe("stalled");
    expect(line?.text).toContain("не менялись");
    expect(line?.text).toContain("⏸");
  });

  test("numbers that moved are not a stall", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0 }));
    pulse.pulse(T0);
    pulse.observe(observation({ at: T0 + PULSE_INTERVAL_MS, outputTokens: 4_100 }));

    expect(pulse.pulse(T0 + PULSE_INTERVAL_MS)[0]?.state).toBe("working");
  });

  test("two observations between one pulse and the next are not two pulses", () => {
    // The observations are two minutes apart and a session may reasonably be
    // quiet for two minutes. The claim is about the longer stretch, so it is
    // made against the previous pulse.
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0 }));
    pulse.observe(observation({ at: T0 + 120_000 }));
    pulse.observe(observation({ at: T0 + 240_000 }));

    expect(pulse.pulse(T0 + 240_000)[0]?.state).toBe("working");
  });

  test("a session that went idle and came back starts the count again", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0 }));
    pulse.pulse(T0);
    pulse.observe(observation({ at: T0 + 60_000, busy: false, paneSpinner: false }));
    pulse.pulse(T0 + 60_000);
    pulse.observe(observation({ at: T0 + 120_000 }));

    expect(pulse.pulse(T0 + 120_000)[0]?.state).toBe("working");
  });
});

describe("the activity signal the hang detector borrows", () => {
  test("the numbers moving is activity", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0 }));
    pulse.observe(observation({ at: T0 + 120_000 }));
    expect(pulse.activityAt(7)).toBe(T0);

    pulse.observe(observation({ at: T0 + 240_000, inputTokens: 700_000 }));
    expect(pulse.activityAt(7)).toBe(T0 + 240_000);
  });

  test("and so is the pane, while the numbers stand still", () => {
    // The case that made the detector wrong rather than blind. Between the
    // assistant entry carrying a `tool_use` and the user entry carrying its
    // result the transcript receives nothing, so a session running `bun test`
    // has a frozen token signature for the whole run — and was called hung at
    // five minutes, with a restart button, while its pane filled with output.
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0, pane: pane("✻", 12, "  12 pass") }));
    pulse.observe(observation({ at: T0 + 300_000, pane: pane("✶", 312, "  12 pass", "  340 pass") }));

    expect(pulse.activityAt(7)).toBe(T0 + 300_000);
  });

  test("but a spinner turning on an otherwise unchanged pane is not", () => {
    // The trap in using the pane at all: it is a photograph of a terminal that
    // is animating itself, so a raw comparison always differs and nothing is
    // ever stale — the same lie `last_active` tells. Same output, later frame,
    // more elapsed seconds, higher token counter on the spinner line: none of
    // it is the session doing anything.
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0, pane: pane("✻", 12, "  12 pass") }));
    pulse.observe(observation({ at: T0 + 300_000, pane: pane("·", 312, "  12 pass") }));

    expect(pulse.activityAt(7)).toBe(T0);
  });

  test("nor is the same pane redrawn with different escapes and padding", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0, pane: "● Bash(bun test)\n\n  12 pass\n" }));
    pulse.observe(observation({ at: T0 + 300_000, pane: "\x1b[2K● Bash(bun test)\n  12 pass   \n\n\n" }));

    expect(pulse.activityAt(7)).toBe(T0);
  });

  test("a session that had no pane and then has one has not thereby done anything", () => {
    // The watchdog starting is not the session working — the same shape of
    // mistake `pane_snapshot_at` makes, and it must not enter through the door
    // the pane comparison opens.
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0, pane: null }));
    pulse.observe(observation({ at: T0 + 300_000, pane: pane("✻", 12, "  12 pass") }));

    expect(pulse.activityAt(7)).toBe(T0);
  });

  test("the pulse still reports the figures standing still, whatever the pane did", () => {
    // `changedAt` and `activeAt` are two clocks on purpose: the pulse's line
    // says "цифры не менялись", and it would be a false statement if the pane
    // could reset it.
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0, pane: pane("✻", 12) }));
    pulse.pulse(T0);
    pulse.observe(observation({ at: T0 + PULSE_INTERVAL_MS, pane: pane("✶", 312, "  340 pass") }));

    const [line] = pulse.pulse(T0 + PULSE_INTERVAL_MS);
    expect(line?.state).toBe("stalled");
    expect(line?.text).toContain("не менялись");
  });

  test("a session never observed answers null, not the epoch", () => {
    expect(new SessionPulse().activityAt(99)).toBeNull();
  });

  test("a session that is gone is forgotten, ids being reused", () => {
    const pulse = new SessionPulse();
    pulse.observe(observation({ at: T0 }));
    pulse.forget(new Set<number>());
    expect(pulse.activityAt(7)).toBeNull();
  });
});

describe("the formats", () => {
  test("tokens", () => {
    expect(shortTokens(421)).toBe("421");
    expect(shortTokens(3_900)).toBe("3.9k");
    expect(shortTokens(611_571)).toBe("611.6k");
    expect(shortTokens(1_000_000)).toBe("1.0M");
  });

  test("elapsed", () => {
    expect(shortElapsed(20_000)).toBe("20s");
    expect(shortElapsed(260_000)).toBe("4m");
    expect(shortElapsed(2 * 60 * 60_000 + 5 * 60_000)).toBe("2h 5m");
  });
});

describe("the loop that posts it", () => {
  let http: FakeFetch;
  let restore: () => void;

  beforeEach(() => {
    resetContextHighWater();
    resetSessionPulse();
    ({ http, restore } = installFakeFetch());
    http.program("api.telegram.org", () => ({ json: { ok: true, result: { message_id: 950 } } }));
  });

  afterEach(() => restore());

  /** One tick of the loop that already reads every active session's transcript. */
  async function tick(rows: unknown[], reading: Record<string, unknown>): Promise<FakeSql> {
    const db = new FakeSql();
    db.program("SELECT s.id", { rows });
    await checkContextPressure(db.sql as never, {
      readContext: async () => reading as never,
      summarize: async () => "a summary",
    });
    return db;
  }

  const workingRow = (overrides: Record<string, unknown> = {}) => ({
    session_id: 7,
    project: "helyx",
    project_path: "/home/u/proj",
    model: "claude-opus-5",
    busy: true,
    chat_id: "555",
    turn_started_at: new Date(Date.now() - 260_000),
    pane_snapshot: null,
    pane_snapshot_at: null,
    metadata: {},
    ...overrides,
  });

  test("nothing is sent when there is nothing to report", async () => {
    await tick([workingRow({ busy: false })], { tokens: 100_000, window: 1_000_000 });

    await sendSessionPulse();

    expect(http.count("sendMessage")).toBe(0);
  });

  test("a working session gets a line, assembled from the read that already happened", async () => {
    // AC13: the pulse takes no `sql` and opens no file. Everything in the line
    // came off the context-pressure loop's tick above.
    await tick([workingRow()], {
      tokens: 611_571,
      window: 1_000_000,
      outputTokens: 3_900,
      activity: "● Bash: bun test",
    });

    await sendSessionPulse();

    const text = String((http.last("sendMessage")?.body as { text?: string })?.text ?? "");
    expect(text).toContain("Пульс");
    expect(text).toContain("helyx");
    expect(text).toContain("↑ 611.6k");
    expect(text).toContain("↓ 3.9k");
    expect(text).toContain("bun test");
  });

  test("a session under a limit is left to its own report", async () => {
    await tick(
      [workingRow({ metadata: { limit: { kind: "session-limit", startedAt: Date.now() - 60_000, resetsAt: Date.now() + 60 * 60_000 } } })],
      { tokens: 611_571, window: 1_000_000, outputTokens: 3_900 },
    );

    await sendSessionPulse();

    expect(http.count("sendMessage")).toBe(0);
  });

  test("the header counts the ones that have stopped moving", async () => {
    const reading = { tokens: 611_571, window: 1_000_000, outputTokens: 3_900, activity: "● Bash: bun test" };
    await tick([workingRow()], reading);
    await sendSessionPulse();
    await tick([workingRow()], reading);

    await sendSessionPulse();

    const text = String((http.last("sendMessage")?.body as { text?: string })?.text ?? "");
    expect(text).toContain("без движения");
    expect(text).toContain("⏸");
  });
});

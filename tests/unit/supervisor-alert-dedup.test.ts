import { describe, test, expect } from "bun:test";
import { shouldAlertNow, recoveryDecision } from "../../scripts/supervisor.ts";

/**
 * The supervisor's alert gate. Getting it wrong is quiet in one direction and
 * loud in the other: too permissive and one stuck session alerts every 60s
 * loop forever, too strict and a real incident is never reported. Both
 * silencers — the operator's acknowledgement and the dedup window — are
 * exercised here against the real implementation, with the clock passed in.
 */

const WINDOW = 5 * 60 * 1000;
const T0 = 1_700_000_000_000;

const freshState = () => ({
  alertedAt: new Map<string, number>(),
  ackedUntil: new Map<string, number>(),
});

describe("shouldAlertNow — dedup window", () => {
  test("the first alert for a key goes out", () => {
    expect(shouldAlertNow(freshState(), "session_problem:helyx", T0, WINDOW)).toBe(true);
  });

  test("a second alert inside the window is suppressed", () => {
    const state = freshState();
    shouldAlertNow(state, "k", T0, WINDOW);
    expect(shouldAlertNow(state, "k", T0 + WINDOW - 1, WINDOW)).toBe(false);
  });

  test("an alert exactly at the window boundary goes out", () => {
    const state = freshState();
    shouldAlertNow(state, "k", T0, WINDOW);
    expect(shouldAlertNow(state, "k", T0 + WINDOW, WINDOW)).toBe(true);
  });

  test("a suppressed check does not push the next alert further away", () => {
    // The window is armed when an alert is sent, not when one is attempted.
    // If a suppressed check re-armed it, a loop running every 60s would
    // silence the key permanently.
    const state = freshState();
    shouldAlertNow(state, "k", T0, WINDOW);
    for (let t = 60_000; t < WINDOW; t += 60_000) {
      expect(shouldAlertNow(state, "k", T0 + t, WINDOW)).toBe(false);
    }
    expect(shouldAlertNow(state, "k", T0 + WINDOW, WINDOW)).toBe(true);
  });

  test("keys are independent", () => {
    const state = freshState();
    expect(shouldAlertNow(state, "session_problem:helyx", T0, WINDOW)).toBe(true);
    expect(shouldAlertNow(state, "session_problem:keryx", T0, WINDOW)).toBe(true);
    expect(shouldAlertNow(state, "session_problem:helyx", T0 + 1, WINDOW)).toBe(false);
  });
});

describe("shouldAlertNow — acknowledgement", () => {
  test("an active ack suppresses the alert", () => {
    const state = freshState();
    state.ackedUntil.set("k", T0 + 30 * 60 * 1000);
    expect(shouldAlertNow(state, "k", T0, WINDOW)).toBe(false);
  });

  test("an expired ack does not suppress", () => {
    const state = freshState();
    state.ackedUntil.set("k", T0 - 1);
    expect(shouldAlertNow(state, "k", T0, WINDOW)).toBe(true);
  });

  test("an ack expiring exactly now does not suppress", () => {
    const state = freshState();
    state.ackedUntil.set("k", T0);
    expect(shouldAlertNow(state, "k", T0, WINDOW)).toBe(true);
  });

  test("an ack does not arm the dedup window", () => {
    // Suppression by ack must leave no trace: the moment it lapses the next
    // check is the key's first alert, not one that has to wait out a window
    // it never triggered.
    const state = freshState();
    state.ackedUntil.set("k", T0 + 1000);
    expect(shouldAlertNow(state, "k", T0, WINDOW)).toBe(false);
    expect(state.alertedAt.has("k")).toBe(false);
    expect(shouldAlertNow(state, "k", T0 + 1000, WINDOW)).toBe(true);
  });

  test("an ack silences a key that already alerted, and the alert resumes after it lapses", () => {
    const state = freshState();
    expect(shouldAlertNow(state, "k", T0, WINDOW)).toBe(true);
    state.ackedUntil.set("k", T0 + 30 * 60 * 1000);
    expect(shouldAlertNow(state, "k", T0 + WINDOW, WINDOW)).toBe(false);
    expect(shouldAlertNow(state, "k", T0 + 30 * 60 * 1000, WINDOW)).toBe(true);
  });

  test("an ack on one key leaves the others alone", () => {
    const state = freshState();
    state.ackedUntil.set("session_problem:helyx", T0 + 60_000);
    expect(shouldAlertNow(state, "session_problem:helyx", T0, WINDOW)).toBe(false);
    expect(shouldAlertNow(state, "session_problem:keryx", T0, WINDOW)).toBe(true);
  });
});

describe("recoveryDecision", () => {
  const HOLD = 60_000;

  test("a non-clean tick resets, whatever the timer said", () => {
    expect(recoveryDecision(false, undefined, T0, HOLD)).toBe("reset");
    expect(recoveryDecision(false, T0 - HOLD * 2, T0, HOLD)).toBe("reset");
  });

  test("the first clean tick starts the hold", () => {
    expect(recoveryDecision(true, undefined, T0, HOLD)).toBe("start-hold");
  });

  test("a clean tick inside the hold keeps waiting", () => {
    expect(recoveryDecision(true, T0, T0 + HOLD - 1, HOLD)).toBe("keep-waiting");
  });

  test("a clean tick at the hold boundary resolves", () => {
    expect(recoveryDecision(true, T0, T0 + HOLD, HOLD)).toBe("resolve");
  });

  test("recovery must be continuous, not cumulative", () => {
    // Clean, then a relapse, then clean again: the second clean run starts its
    // own hold rather than inheriting the first one's elapsed time. Resolving
    // on cumulative cleanliness would edit the alert to ✅ during an incident
    // that never actually stopped.
    expect(recoveryDecision(true, undefined, T0, HOLD)).toBe("start-hold");
    expect(recoveryDecision(false, T0, T0 + 30_000, HOLD)).toBe("reset");
    expect(recoveryDecision(true, undefined, T0 + 31_000, HOLD)).toBe("start-hold");
    expect(recoveryDecision(true, T0 + 31_000, T0 + 61_000, HOLD)).toBe("keep-waiting");
  });

  test("a clean timer from the future does not resolve early", () => {
    // Clock skew or a re-set timer; `now - cleanSince` goes negative.
    expect(recoveryDecision(true, T0 + 10_000, T0, HOLD)).toBe("keep-waiting");
  });

  test("a zero hold resolves on the tick after the timer starts", () => {
    expect(recoveryDecision(true, T0, T0, 0)).toBe("resolve");
  });
});

describe("recoveryDecision — falsy timers", () => {
  const HOLD = 60_000;

  test("a zero timestamp is no timer, not an ancient one", () => {
    // The `if (cleanSince && …)` this replaced treated 0 as absent. Resolving
    // on it instead would declare an incident over on its first clean tick.
    expect(recoveryDecision(true, 0, T0, HOLD)).toBe("start-hold");
  });

  test("NaN is no timer either", () => {
    expect(recoveryDecision(true, NaN, T0, HOLD)).toBe("start-hold");
  });
});

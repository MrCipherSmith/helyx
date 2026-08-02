import { describe, test, expect } from "bun:test";
import { shouldAlertNow } from "../../scripts/supervisor.ts";

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

/**
 * Reading what Claude Code says when a turn fails on the API.
 *
 * The operator's symptom: a session that hit its limit stops answering, the
 * hung-session loop finds it stale five minutes later, and offers a restart
 * button that cannot help — the limit is on the account, not the process. The
 * cure starts here, with telling the two apart.
 *
 * Every text below is verbatim from this project's own transcripts between
 * 2026-07-07 and 2026-08-08, where twelve limit events were recorded and none
 * were read by anything.
 */

import { describe, test, expect } from "bun:test";
import { parseApiError, parseResetTime, isLimitKind } from "../../utils/context-usage.ts";

/** The envelope as the CLI writes it, trimmed to what the parser reads. */
const entry = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  isApiErrorMessage: true,
  message: { model: "<synthetic>", role: "assistant", content: text },
  ...extra,
});

describe("parseApiError — the five observed texts", () => {
  test("a session limit, with the time it lifts", () => {
    const e = parseApiError(entry("You've hit your session limit · resets 5:30pm (UTC)"))!;
    expect(e.kind).toBe("session-limit");
    expect(e.resetsAtUtcMinutes).toBe(17 * 60 + 30);
  });

  test("a weekly limit is not a session limit", () => {
    // Both say "limit"; the difference is hours against days, and the operator
    // needs to know which one they are waiting out.
    const e = parseApiError(entry("You've hit your weekly limit · resets 2pm (UTC)"))!;
    expect(e.kind).toBe("weekly-limit");
    expect(e.resetsAtUtcMinutes).toBe(14 * 60);
  });

  test("an overloaded server is not a limit", () => {
    const e = parseApiError(entry(
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
    ))!;
    expect(e.kind).toBe("overloaded");
    expect(isLimitKind(e.kind)).toBe(false);
    expect(e.resetsAtUtcMinutes).toBeNull();
  });

  test("a prompt too long, and a lost connection", () => {
    expect(parseApiError(entry("Prompt is too long"))!.kind).toBe("prompt-too-long");
    expect(parseApiError(entry("API Error: Unable to connect to API (ENOTFOUND)"))!.kind).toBe("network");
  });

  test("an unfamiliar error is reported, not dropped", () => {
    // The wording belongs to another program. Losing an error because its
    // phrasing moved is worse than reporting one we cannot name.
    const e = parseApiError(entry("API Error: 418 I'm a teapot"))!;
    expect(e.kind).toBe("other");
    expect(e.text).toContain("teapot");
  });
});

describe("parseApiError — what is not an error", () => {
  test("a session discussing limits is not a session hitting one", () => {
    // This repository talks about rate limits constantly; matching the prose
    // would turn a conversation about the problem into a report of it.
    expect(parseApiError({
      type: "assistant",
      message: { role: "assistant", content: "You've hit your session limit · resets 5:30pm (UTC) is the text we parse" },
    })).toBeNull();
  });

  test("the flag alone decides, and an empty message is not an error", () => {
    expect(parseApiError({ type: "assistant", isApiErrorMessage: false, message: { content: "Prompt is too long" } })).toBeNull();
    expect(parseApiError(entry("   "))).toBeNull();
    expect(parseApiError(null)).toBeNull();
    expect(parseApiError("isApiErrorMessage")).toBeNull();
  });

  test("content as blocks reads the same as content as a string", () => {
    const e = parseApiError({
      type: "assistant",
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "You've hit your weekly limit · resets 2pm (UTC)" }] },
    })!;
    expect(e.kind).toBe("weekly-limit");
  });
});

describe("parseResetTime", () => {
  test("both observed shapes", () => {
    expect(parseResetTime("· resets 5:30pm (UTC)")).toBe(17 * 60 + 30);
    expect(parseResetTime("· resets 2pm (UTC)")).toBe(14 * 60);
  });

  test("midnight and noon, where am/pm is a trap", () => {
    expect(parseResetTime("resets 12am (UTC)")).toBe(0);
    expect(parseResetTime("resets 12pm (UTC)")).toBe(12 * 60);
    expect(parseResetTime("resets 12:45am (UTC)")).toBe(45);
  });

  test("anything it has not met is null, not a guess", () => {
    // A wrong reset time decides when the limit marker stops suppressing the
    // hung-session alarm, so a guess here silences a real hang.
    expect(parseResetTime("resets 5:30pm (PST)")).toBeNull();
    expect(parseResetTime("resets tomorrow")).toBeNull();
    expect(parseResetTime("resets 25:00 (UTC)")).toBeNull();
    expect(parseResetTime("resets 5:99pm (UTC)")).toBeNull();
    expect(parseResetTime("no reset here")).toBeNull();
  });
});

describe("isLimitKind", () => {
  test("only the two that mean the account is out of allowance", () => {
    expect(isLimitKind("session-limit")).toBe(true);
    expect(isLimitKind("weekly-limit")).toBe(true);
    for (const k of ["overloaded", "prompt-too-long", "network", "other"] as const) {
      expect(isLimitKind(k)).toBe(false);
    }
  });
});

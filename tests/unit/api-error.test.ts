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
import {
  parseApiError,
  parseResetTime,
  isLimitKind,
  apiErrors,
  newestContextTokens,
  newestOutputTokens,
  newestAnswerAt,
} from "../../utils/context-usage.ts";

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

describe("apiErrors — reading them out of a poll's worth of lines", () => {
  /** A line as the tail hands it over, with the uuid Claude Code writes on every entry. */
  const line = (uuid: string, text: string) =>
    JSON.stringify({ ...entry(text), uuid, message: { model: "<synthetic>", content: text } });

  test("the uuid travels with the error, because it is what stops a second alert", () => {
    const [found] = apiErrors([line("abc-123", "You've hit your session limit · resets 5:30pm (UTC)")]);
    expect(found?.uuid).toBe("abc-123");
    expect(found?.kind).toBe("session-limit");
  });

  test("two errors in one poll are both reported, oldest first", () => {
    const found = apiErrors([
      line("one", "API Error: 529 Overloaded"),
      JSON.stringify({ type: "assistant", message: { content: "ordinary work" } }),
      line("two", "You've hit your weekly limit · resets 2pm (UTC)"),
    ]);
    expect(found.map((e) => e.kind)).toEqual(["overloaded", "weekly-limit"]);
  });

  test("an unparseable line is skipped, not thrown on", () => {
    // The first line of a tail is usually a fragment — the read starts near a
    // byte offset, not at a record boundary.
    expect(apiErrors(['{"type":"assis', ""])).toEqual([]);
  });

  test("an error with no uuid is still reported", () => {
    const [found] = apiErrors([JSON.stringify(entry("Prompt is too long"))]);
    expect(found?.kind).toBe("prompt-too-long");
    expect(found?.uuid).toBeNull();
  });

  test("the line's own timestamp travels with it, because read time is a lie", () => {
    // `reresolve` attaches to a different transcript at offset 0 and replays
    // the whole file, so a line the caller is reading now may have been written
    // yesterday — and the caller resolves "resets 5:30pm" against whichever
    // instant it is handed.
    const at = "2026-08-07T17:00:00.000Z";
    const line = JSON.stringify({ ...entry("You've hit your session limit · resets 5:30pm (UTC)"), uuid: "u", timestamp: at });

    expect(apiErrors([line])[0]?.at).toBe(Date.parse(at));
  });

  test("a line with no timestamp says so rather than guessing one", () => {
    expect(apiErrors([JSON.stringify(entry("Prompt is too long"))])[0]?.at).toBeNull();
  });
});

describe("the zeros a synthetic entry carries", () => {
  /** What the CLI writes: no call was made, so every counter is zero. */
  const errorLine = JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    uuid: "err-1",
    message: {
      model: "<synthetic>",
      content: "You've hit your session limit · resets 5:30pm (UTC)",
      usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  });
  const realLine = JSON.stringify({
    type: "assistant",
    uuid: "real-1",
    message: {
      model: "claude-opus-5",
      content: [],
      usage: { input_tokens: 2, cache_read_input_tokens: 610_456, cache_creation_input_tokens: 1_113, output_tokens: 421 },
    },
  });

  test("the newest context reading skips it", () => {
    // The error is by definition the newest entry in a session that just hit
    // its limit. Read as a measurement it says 0 tokens — so the pressure loop
    // would report a nearly full window as empty, release its high-water mark
    // and log `below-threshold`. Confidently wrong beats absent, and this is
    // the confidently-wrong one.
    expect(newestContextTokens([realLine, errorLine])).toBe(611_571);
  });

  test("and so does the newest output reading", () => {
    expect(newestOutputTokens([realLine, errorLine])).toBe(421);
  });

  test("a transcript that is only an error measures nothing, rather than zero", () => {
    expect(newestContextTokens([errorLine])).toBeNull();
    expect(newestOutputTokens([errorLine])).toBeNull();
  });
});

describe("newestAnswerAt — the evidence a limit is over", () => {
  const at = "2026-08-08T09:10:00.000Z";

  const real = (timestamp: string | null) =>
    JSON.stringify({
      type: "assistant",
      uuid: "real-1",
      ...(timestamp ? { timestamp } : {}),
      message: { model: "claude-opus-5", content: [], usage: { input_tokens: 12, output_tokens: 4 } },
    });
  const synthetic = (timestamp: string) =>
    JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      uuid: "err-1",
      timestamp,
      message: {
        model: "<synthetic>",
        content: "You've hit your session limit · resets 5:30pm (UTC)",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

  test("a real answer is dated by the transcript, not by the reader", () => {
    expect(newestAnswerAt([real(at)])).toBe(Date.parse(at));
  });

  test("the error entry the CLI manufactured is not an answer", () => {
    // Its usage block is zeros because no call was made. Read as an answer it
    // would clear the very marker it caused.
    expect(newestAnswerAt([synthetic(at)])).toBeNull();
  });

  test("an entry with no usage is not an answer either", () => {
    const toolResult = JSON.stringify({ type: "user", timestamp: at, message: { content: "42 lines" } });
    expect(newestAnswerAt([toolResult])).toBeNull();
  });

  test("the newest one wins, the file being read forwards", () => {
    const later = "2026-08-08T09:12:00.000Z";
    expect(newestAnswerAt([real(at), real(later)])).toBe(Date.parse(later));
  });

  test("an answer the CLI wrote without a timestamp cannot be placed, so it is skipped", () => {
    // Dating it to now would be the guess this function exists to stop making.
    expect(newestAnswerAt([real(at), real(null)])).toBe(Date.parse(at));
    expect(newestAnswerAt([real(null)])).toBeNull();
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

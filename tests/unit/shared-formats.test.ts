import { describe, test, expect } from "bun:test";
import { parseDuration } from "../../utils/duration.ts";
import { stripReasoning } from "../../utils/llm-output.ts";
import { isValidSkillName, INLINE_SHELL_TOKEN, inlineShellTokens } from "../../utils/skill-format.ts";

/**
 * Four formats that more than one module has to agree about, each of which had
 * been written out separately in every place that read it.
 *
 * The tests state the expected values directly rather than comparing the new
 * implementation against the old one: a test that only asserts "the same as
 * before" cannot tell a preserved behaviour from a preserved bug.
 */

describe("parseDuration", () => {
  test("minutes, hours and days, in milliseconds", () => {
    // Stated, not derived. The conversion was the duplicated part — both call
    // sites carried their own 60_000 / 3_600_000 / 86_400_000 — so an
    // off-by-1000 is exactly what this has to catch.
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  test("zero is a duration", () => {
    expect(parseDuration("0m")).toBe(0);
  });

  test("a malformed value is null, not a default", () => {
    // The two callers disagree about what to do with a bad value and both are
    // right: one falls back to an hour, the other exits with a usage message.
    // Choosing here would have silently changed one of them.
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("30")).toBeNull();
    expect(parseDuration("m")).toBeNull();
    expect(parseDuration("30s")).toBeNull();
    expect(parseDuration("1.5h")).toBeNull();
    expect(parseDuration("-1h")).toBeNull();
    expect(parseDuration("30M")).toBeNull();
    expect(parseDuration(" 30m ")).toBeNull();
  });
});

describe("isValidSkillName", () => {
  test("accepts the shape a skill directory can have", () => {
    expect(isValidSkillName("a")).toBe(true);
    expect(isValidSkillName("git-state")).toBe(true);
    expect(isValidSkillName("skill-2")).toBe(true);
  });

  test("must start with a letter", () => {
    expect(isValidSkillName("2fast")).toBe(false);
    expect(isValidSkillName("-leading")).toBe(false);
  });

  test("lowercase only", () => {
    expect(isValidSkillName("Skill")).toBe(false);
    expect(isValidSkillName("gitState")).toBe(false);
  });

  test("no path characters — the name becomes a directory", () => {
    // The rule forbids rather than escapes, because the value is used to build
    // ~/.claude/skills/agent-created/<name>/SKILL.md.
    expect(isValidSkillName("a/b")).toBe(false);
    expect(isValidSkillName("../escape")).toBe(false);
    expect(isValidSkillName("a b")).toBe(false);
    expect(isValidSkillName("a_b")).toBe(false);
    expect(isValidSkillName("a.b")).toBe(false);
  });

  test("64 characters, and the boundary is exact", () => {
    expect(isValidSkillName("a" + "b".repeat(63))).toBe(true);
    expect(isValidSkillName("a" + "b".repeat(64))).toBe(false);
  });

  test("empty is not a name", () => {
    expect(isValidSkillName("")).toBe(false);
  });
});

describe("inline shell tokens", () => {
  test("detects a token", () => {
    expect(INLINE_SHELL_TOKEN.test("run !`git status` here")).toBe(true);
  });

  test("a token does not span lines", () => {
    expect(INLINE_SHELL_TOKEN.test("!`git\nstatus`")).toBe(false);
  });

  test("a bare backtick span is not a token", () => {
    expect(INLINE_SHELL_TOKEN.test("`git status`")).toBe(false);
  });

  test("the expansion form captures the command", () => {
    const matches = [..."a !`one` b !`two`".matchAll(inlineShellTokens())];
    expect(matches.map((m) => m[1])).toEqual(["one", "two"]);
  });

  test("each call gets a fresh global regex", () => {
    // A `g` regex carries lastIndex. Sharing one instance between an expansion
    // loop and anything else makes the second caller start wherever the first
    // stopped.
    const a = inlineShellTokens();
    a.exec("!`first`");
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(inlineShellTokens().lastIndex).toBe(0);
  });
});

describe("stripReasoning", () => {
  test("removes a reasoning block", () => {
    expect(stripReasoning("<think>weighing it up</think>The answer")).toBe("The answer");
  });

  test("removes several", () => {
    expect(stripReasoning("<think>a</think>one<think>b</think>two")).toBe("onetwo");
  });

  test("a block spanning lines goes whole", () => {
    expect(stripReasoning("<think>\nline one\nline two\n</think>\nanswer")).toBe("answer");
  });

  test("non-greedy — the answer between two blocks survives", () => {
    // A greedy match would swallow everything from the first <think> to the
    // last </think>, taking the answer with it.
    expect(stripReasoning("<think>a</think>KEEP ME<think>b</think>")).toBe("KEEP ME");
  });

  test("text with no block is only trimmed", () => {
    expect(stripReasoning("  plain answer  ")).toBe("plain answer");
  });

  test("an empty response stays empty", () => {
    expect(stripReasoning("")).toBe("");
    expect(stripReasoning("<think>only reasoning</think>")).toBe("");
  });
});

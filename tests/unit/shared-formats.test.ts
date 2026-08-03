import { describe, test, expect } from "bun:test";
import { parseDuration } from "../../utils/duration.ts";
import { stripReasoning, REASONING_OPEN, REASONING_CLOSE } from "../../utils/llm-output.ts";
import { isValidSkillName, INLINE_SHELL_TOKEN, inlineShellTokens } from "../../utils/skill-format.ts";
import { durationOrHour } from "../../bot/commands/tmux-log.ts";

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

describe("the definitions reach beyond the modules that import them", () => {
  test("the prompt tells the model the same name rule the validator enforces", async () => {
    // prompts/skill-distillation.md states the rule in prose for the LLM that
    // generates skill names. It is not TypeScript, so the duplicate detector
    // does not scan it — and if the two drifted, the model would confidently
    // produce names the validator rejects.
    const prompt = await Bun.file("prompts/skill-distillation.md").text();
    const quoted = prompt.match(/regex \^\[a-z\]\[a-z0-9-\]\{0,63\}\$/);
    expect(quoted).not.toBeNull();

    // And the rule it quotes agrees with the implementation on the boundaries
    // that matter.
    expect(isValidSkillName("git-state")).toBe(true);
    expect(isValidSkillName("a".repeat(64))).toBe(true);
    expect(isValidSkillName("a".repeat(65))).toBe(false);
    expect(isValidSkillName("Git-State")).toBe(false);
  });

  test("the streaming path uses the same tags stripReasoning removes", () => {
    // claude/client.ts decides what to forward token by token and cannot wait
    // for a closing tag, so it needs the tags rather than the block pattern.
    // Sharing them is what keeps the two paths agreeing about where reasoning
    // starts and ends.
    expect(stripReasoning(`${REASONING_OPEN}hidden${REASONING_CLOSE}shown`)).toBe("shown");
    expect(REASONING_OPEN).toBe("<think>");
    expect(REASONING_CLOSE).toBe("</think>");
  });
});

describe("durationOrHour — the fallback contract", () => {
  test("a good duration parses", () => {
    expect(durationOrHour("30m")).toBe(1_800_000);
  });

  test("a bad one falls back to an hour rather than failing", () => {
    // This command's contract, and the reason parseDuration returns null: the
    // other caller exits instead, and folding either choice into the shared
    // function would have silently changed one of them.
    expect(durationOrHour("nonsense")).toBe(3_600_000);
    expect(durationOrHour("")).toBe(3_600_000);
    expect(durationOrHour("30s")).toBe(3_600_000);
  });
});

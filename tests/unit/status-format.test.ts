import { describe, test, expect } from "bun:test";
import {
  parseTokenCount,
  formatElapsed,
  getSpinnerIcon,
  computeSignature,
  detectPhase,
  isPermissionPrompt,
  SPINNER_FRAMES,
  SPINNER_STALE_MS,
} from "../../utils/status-format.ts";
import { parseStatus } from "../../utils/tmux-monitor.ts";

/**
 * What the live status message shows while Claude works.
 *
 * `detectPhase` decides the emoji at the head of that line, and 💬 is the one
 * the operator watches for — it means the session is blocked on a permission
 * prompt. The version this replaced raised it whenever the words `permission`,
 * `approve` or `waiting` appeared anywhere in the stage text, tool calls
 * included, which in this codebase is often.
 */

describe("detectPhase — the false waiting signals", () => {
  test("a bash command that greps for the word waiting is running, not waiting", () => {
    expect(detectPhase('● $ grep -rn "waiting" src/')).toBe("running");
  });

  test("reading a file whose path contains permission is reading", () => {
    expect(detectPhase("● Read: docs/permissions.md")).toBe("reading");
  });

  test("running a script named approve-something is running", () => {
    expect(detectPhase("● $ npm run approve-release")).toBe("running");
  });

  test("the control case was already right", () => {
    expect(detectPhase("● Read: src/index.ts")).toBe("reading");
  });
});

describe("detectPhase — a real permission prompt still reports waiting", () => {
  // Copied from tests/unit/tmux-watchdog.test.ts, not paraphrased: losing a
  // genuine 💬 means a blocked session nobody notices, which is far worse than
  // the false ones this change removes.
  const dialog = [
    "  ● mcp__docker__docker_container_list (MCP)",
    "  Do you want to proceed?",
    "  ❯ 1. Yes",
    "    2. Yes, and don't ask again",
    "    3. No",
  ].join("\n");

  test("the dialog is recognised even though it carries a tool bullet", () => {
    // This is what broke the first version of the fix: a rule keyed on "is
    // there a bullet line" cannot tell a prompt from an ordinary tool call,
    // because the prompt has one too.
    expect(detectPhase(dialog)).toBe("waiting");
  });

  test("the signal alone is enough", () => {
    expect(detectPhase("Do you want to proceed?")).toBe("waiting");
  });

  test("the choice line alone is enough", () => {
    expect(detectPhase("❯ 1. Yes")).toBe("waiting");
    expect(detectPhase("❯ 2) Yes, and don't ask again")).toBe("waiting");
  });

  test("isPermissionPrompt agrees with detectPhase on the dialog", () => {
    expect(isPermissionPrompt(dialog)).toBe(true);
    expect(isPermissionPrompt('● $ grep -rn "waiting" src/')).toBe(false);
  });

  test("a numbered list that is not the dialog does not count", () => {
    expect(isPermissionPrompt("1. Yes\n2. No")).toBe(false);
  });
});

describe("detectPhase — tool lines", () => {
  test.each([
    ["● $ ls -la", "running"],
    ["● Read: package.json", "reading"],
    ["● Write: out.txt", "writing"],
    ["● Edit: src/a.ts", "writing"],
    ["● Creating file", "writing"],
    ["● MCP: docker_container_list", "searching"],
    ["● Grep: pattern", "searching"],
    ["● Agent(explore the repo)", "running"],
    ["● SomeTool doing a thing", "running"],
  ])("%s → %s", (stage, phase) => {
    expect(detectPhase(stage)).toBe(phase as never);
  });

  test("the last bullet line wins, since it is the current call", () => {
    const stage = ["⠋ working", "● Read: a.ts", "● $ npm test"].join("\n");
    expect(detectPhase(stage)).toBe("running");
  });
});

describe("detectPhase — prose", () => {
  test.each([
    ["Thinking about the problem", "thinking"],
    ["Write the report", "writing"],
    ["Reading the spec", "reading"],
    ["Executing the plan", "running"],
    ["Searching for usages", "searching"],
  ])("%s → %s", (stage, phase) => {
    expect(detectPhase(stage)).toBe(phase as never);
  });

  test("the prose fallback matches word stems inconsistently — pinned, not fixed", () => {
    // "Creating" contains the stem "creat" and is caught; "Writing" does not
    // contain "write" and falls through to thinking. Pre-existing, moved
    // verbatim, and written down here rather than corrected: changing which
    // emoji a status shows is a decision of its own.
    expect(detectPhase("Creating the file")).toBe("writing");
    expect(detectPhase("Writing the report")).toBe("thinking");
  });

  test("prose may still say it is waiting — there is no tool line to leak from", () => {
    // A status written by hand. The words only misled when they could come
    // from a tool call's text.
    expect(detectPhase("waiting for approval")).toBe("waiting");
    expect(detectPhase("Waiting on permission from the operator")).toBe("waiting");
  });

  test("empty and whitespace input show no emoji at all", () => {
    expect(detectPhase("")).toBeNull();
    expect(detectPhase("   \n  ")).toBeNull();
  });
});

describe("parseTokenCount", () => {
  test("a plain count", () => {
    expect(parseTokenCount("15234 tokens")).toBe(15234);
  });

  test("thousands and millions", () => {
    expect(parseTokenCount("2.5k tokens")).toBe(2500);
    expect(parseTokenCount("1.2M tokens")).toBe(1_200_000);
  });

  test("case does not matter", () => {
    expect(parseTokenCount("2.5K TOKENS")).toBe(2500);
    expect(parseTokenCount("1.2m Tokens")).toBe(1_200_000);
  });

  test("comma grouping is stripped", () => {
    expect(parseTokenCount("15,234 tokens")).toBe(15234);
  });

  test("the singular is accepted", () => {
    expect(parseTokenCount("1 token")).toBe(1);
  });

  test("a suffix with no space still parses", () => {
    expect(parseTokenCount("2.5ktokens")).toBe(2500);
  });

  test("rejects anything that is not a token count", () => {
    expect(parseTokenCount("hello")).toBeNull();
    expect(parseTokenCount("")).toBeNull();
    expect(parseTokenCount("15234")).toBeNull();
    expect(parseTokenCount("2.5g tokens")).toBeNull();
  });

  test("several dots are accepted and silently truncated — a defect, pinned", () => {
    // The character class admits any number of dots, so parseFloat stops at
    // the second one. Written down rather than fixed here: changing it changes
    // what the status line shows.
    expect(parseTokenCount("1.2.3 tokens")).toBe(1);
  });
});

describe("formatElapsed", () => {
  test("under a minute is seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5_400)).toBe("5s");
    expect(formatElapsed(59_400)).toBe("59s");
  });

  test("a minute and above is minutes and seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(90_000)).toBe("1m 30s");
  });

  test("an hour reads as 60m — no hours unit, pinned as-is", () => {
    expect(formatElapsed(3_600_000)).toBe("60m 0s");
  });

  test("seconds are rounded, not truncated", () => {
    expect(formatElapsed(1_600)).toBe("2s");
  });
});

describe("getSpinnerIcon", () => {
  const T = 1_700_000_000_000;

  test("cycles through the frames", () => {
    expect(getSpinnerIcon(0, T, T)).toBe(SPINNER_FRAMES[0]!);
    expect(getSpinnerIcon(3, T, T)).toBe(SPINNER_FRAMES[3]!);
  });

  test("wraps past the end of the frame list", () => {
    expect(getSpinnerIcon(SPINNER_FRAMES.length, T, T)).toBe(SPINNER_FRAMES[0]!);
    expect(getSpinnerIcon(SPINNER_FRAMES.length + 2, T, T)).toBe(SPINNER_FRAMES[2]!);
  });

  test("a stale monitor shows a warning instead of a spinner", () => {
    expect(getSpinnerIcon(0, T, T + SPINNER_STALE_MS + 1)).toBe("⚠️");
  });

  test("exactly at the threshold is not yet stale", () => {
    expect(getSpinnerIcon(0, T, T + SPINNER_STALE_MS)).toBe(SPINNER_FRAMES[0]!);
  });
});

describe("computeSignature", () => {
  test("is deterministic", () => {
    expect(computeSignature("hello")).toBe(computeSignature("hello"));
  });

  test("differs for different input", () => {
    expect(computeSignature("a")).not.toBe(computeSignature("b"));
    expect(computeSignature("status one")).not.toBe(computeSignature("status two"));
  });

  test("handles an empty string", () => {
    expect(typeof computeSignature("")).toBe("string");
  });

  test("handles multi-byte text without throwing", () => {
    // Status text is full of emoji and Cyrillic.
    expect(typeof computeSignature("⠋ работает 🧠 · ✏️ пишет")).toBe("string");
  });

  test("returns hex", () => {
    expect(computeSignature("anything")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("what a permission dialog actually looks like by the time it gets here", () => {
  // Codex raised this as a blocker on the first version of the fix, and it was
  // right about the mechanism. The tests above feed detectPhase raw pane text,
  // which is not what production feeds it: tmux-monitor parses the pane first.
  const rawPane = [
    "  ● mcp__docker__docker_container_list (MCP)",
    "  Do you want to proceed?",
    "  ❯ 1. Yes",
    "    2. Yes, and don't ask again",
    "    3. No",
  ].join("\n");

  test("the monitor discards both signals the dialog is recognised by", () => {
    // `^❯` is in SKIP_PATTERNS; "Do you want to proceed?" is prose and falls
    // through every branch of parseLine to null. What survives is the bullet.
    const stage = parseStatus(rawPane);
    expect(stage).toBe("● mcp__docker__docker_container_list (MCP)");
    expect(stage).not.toContain("proceed");
    expect(stage).not.toContain("❯");
  });

  test("so neither this classifier nor the one it replaced can see a real prompt", () => {
    // The consequence is the opposite of losing a working signal: 💬 never
    // fired for a real permission request in the first place. The old
    // whole-blob word scan only ever produced the false positives this flow
    // removes — a phase that could not be true.
    const stage = parseStatus(rawPane)!;
    expect(detectPhase(stage)).toBe("searching");
    expect(isPermissionPrompt(stage)).toBe(false);
  });

  test("the handler's own status reads as an ordinary action, so nothing marks the block", () => {
    // channel/permissions.ts sets this while the prompt is pending. A blocked
    // session therefore looks like work, and no 💬 appears — the gap this flow
    // documents rather than half-closes. Announcing it from the handler is the
    // right fix, but only as a latched state: a plain prefix is overwritten by
    // the next monitor poll and never cleared if delivery fails or the request
    // times out. Its own flow.
    expect(detectPhase("Running: npm test")).toBe("running");
    expect(detectPhase("Reading: config.ts")).toBe("reading");
  });
});

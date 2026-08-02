import { describe, test, expect } from "bun:test";
import { parseFlags, flagValue } from "../../utils/cli-flags.ts";

/**
 * Flag parsing for the `helyx` CLI. Untested until now because it lived in
 * cli.ts, which cannot be imported: that file ends in a top-level switch on
 * process.argv.
 *
 * These tests pin current behaviour, including the parts that are arguably
 * quirks. A mis-read flag here does not error — the unattended installer just
 * installs something other than what was asked for.
 */

describe("parseFlags — the three forms", () => {
  test("--key=value", () => {
    expect(parseFlags(["--profile=minimal"])).toEqual({ profile: "minimal" });
  });

  test("--key value", () => {
    expect(parseFlags(["--profile", "minimal"])).toEqual({ profile: "minimal" });
  });

  test("a bare flag becomes the string \"true\", not a boolean", () => {
    // Every value in the map is a string; callers test presence.
    expect(parseFlags(["--force"])).toEqual({ force: "true" });
  });

  test("the three forms mix freely", () => {
    expect(parseFlags(["--profile=minimal", "--force", "--dir", "/opt/helyx"])).toEqual({
      profile: "minimal",
      force: "true",
      dir: "/opt/helyx",
    });
  });
});

describe("parseFlags — value consumption", () => {
  test("a following flag is not eaten as a value", () => {
    // `--force --profile minimal` must not read "--profile" as force's value.
    expect(parseFlags(["--force", "--profile", "minimal"])).toEqual({
      force: "true",
      profile: "minimal",
    });
  });

  test("a value that itself starts with -- is not consumed", () => {
    // The cost of the rule above: such a value must use the = form.
    expect(parseFlags(["--pattern", "--weird"])).toEqual({
      pattern: "true",
      weird: "true",
    });
    expect(parseFlags(["--pattern=--weird"])).toEqual({ pattern: "--weird" });
  });

  test("a trailing flag with no value is bare", () => {
    expect(parseFlags(["--dir", "/opt", "--force"])).toEqual({ dir: "/opt", force: "true" });
  });

  test("a single-dash argument is a value, not a flag", () => {
    expect(parseFlags(["--level", "-1"])).toEqual({ level: "-1" });
  });
});

describe("parseFlags — inputs that are not flags", () => {
  test("positional arguments are ignored", () => {
    expect(parseFlags(["connect", ".", "--tmux"])).toEqual({ tmux: "true" });
  });

  test("an empty argv yields an empty map", () => {
    expect(parseFlags([])).toEqual({});
  });

  test("a lone -- becomes a flag with an empty name", () => {
    // Quirk, pinned rather than corrected: `--` is treated as `--<empty>`.
    expect(parseFlags(["--"])).toEqual({ "": "true" });
  });
});

describe("parseFlags — repeats and empties", () => {
  test("a repeated flag keeps the last value", () => {
    expect(parseFlags(["--profile=minimal", "--profile=full"])).toEqual({ profile: "full" });
  });

  test("--key= records an empty string", () => {
    expect(parseFlags(["--token="])).toEqual({ token: "" });
  });

  test("only the first = splits the pair, so values may contain =", () => {
    expect(parseFlags(["--url=postgres://u:p@h/db?x=1"])).toEqual({
      url: "postgres://u:p@h/db?x=1",
    });
  });
});

describe("flagValue", () => {
  test("returns the value when present", () => {
    expect(flagValue({ profile: "minimal" }, "profile")).toBe("minimal");
  });

  test("an absent key is undefined", () => {
    expect(flagValue({}, "profile")).toBeUndefined();
  });

  test("an empty string counts as absent", () => {
    // `--token=` is a flag the operator started to fill in and did not.
    // Treating it as present would write an empty token into .env.
    expect(flagValue({ token: "" }, "token")).toBeUndefined();
  });

  test("\"true\" from a bare flag is a present value", () => {
    expect(flagValue(parseFlags(["--force"]), "force")).toBe("true");
  });

  test("a value of \"false\" is still present — presence is what callers test", () => {
    expect(flagValue({ dashboard: "false" }, "dashboard")).toBe("false");
  });
});

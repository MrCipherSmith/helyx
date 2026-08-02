import { describe, test, expect } from "bun:test";
import {
  extractRegexLiterals,
  extractStringLiterals,
  findDuplicates,
  formatReport,
} from "../../scripts/find-duplicate-definitions.ts";

/**
 * The detector's own parsing, tested against synthetic sources rather than
 * against this repository — otherwise the tests would change meaning every
 * time the code they scan changes, and a checker whose tests drift is worth
 * less than no checker.
 *
 * The thing being guarded against is noise. The first run over this repository
 * reported 138 "duplicates", nearly all of them import specifiers, Tailwind
 * class lists, and divisions that a scanner mistook for patterns. A report at
 * that ratio is a report nobody reads, and then the real findings are
 * invisible.
 */

describe("extractRegexLiterals", () => {
  test("finds a pattern in an assignment", () => {
    expect(extractRegexLiterals('const RE = /^[a-z][a-z0-9-]{0,63}$/;'))
      .toEqual(["/^[a-z][a-z0-9-]{0,63}$/"]);
  });

  test("finds a pattern in a call", () => {
    expect(extractRegexLiterals('s.match(/\\d{4}-\\d{2}/)')).toContain("/\\d{4}-\\d{2}/");
  });

  test("keeps the flags, since they change what the pattern means", () => {
    expect(extractRegexLiterals('x = /do you want to proceed\\?/i')).toEqual([
      "/do you want to proceed\\?/i",
    ]);
  });

  test("a character class containing a slash does not end the literal early", () => {
    expect(extractRegexLiterals('const RE = /[a-z/._-]{3,}/g')).toEqual(["/[a-z/._-]{3,}/g"]);
  });
});

describe("extractRegexLiterals — what must not be reported", () => {
  test("an import path is not a pattern", () => {
    // The prototype reported /memory/summ and /api.telegram.org/ — module
    // paths and URLs, matched because a scan cannot see the difference.
    expect(extractRegexLiterals('import { x } from "../memory/summarizer.ts";')).toEqual([]);
  });

  test("a URL is not a pattern", () => {
    expect(extractRegexLiterals('const u = "https://api.telegram.org/bot123/send";')).toEqual([]);
  });

  test("division is not a pattern", () => {
    expect(extractRegexLiterals("const rate = total / elapsed / 1000;")).toEqual([]);
  });

  test("division inside a template is not a pattern", () => {
    // `${` is the giveaway: no real pattern contains it.
    expect(extractRegexLiterals("`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`"))
      .toEqual([]);
  });

  test("an interpolated URL is not a pattern", () => {
    expect(extractRegexLiterals("`https://api.telegram.org/bot${token}/sendMessage`")).toEqual([]);
  });

  test("string content between two slashes is not a pattern", () => {
    expect(extractRegexLiterals("html += \"</b>').pop()}</span>\";")).toEqual([]);
  });

  test("a pattern too short to be a shared rule is skipped", () => {
    expect(extractRegexLiterals("const RE = /^a$/;")).toEqual([]);
  });

  test("something with no pattern structure at all is skipped", () => {
    expect(extractRegexLiterals('const p = "/usr/local/share/data";')).toEqual([]);
  });
});

describe("extractStringLiterals", () => {
  test("finds a string long enough to be a format", () => {
    const src = 'const s = "postgres://user:pass@host:5432/database";';
    expect(extractStringLiterals(src)).toEqual(['"postgres://user:pass@host:5432/database"']);
  });

  test("a short string is a word, not a format", () => {
    expect(extractStringLiterals('const s = "active";')).toEqual([]);
  });

  test("module specifiers are dropped", () => {
    // Ten files importing the same manager is what importing looks like.
    const src = [
      'import { sessionManager } from "../../sessions/manager.ts";',
      'import { CONFIG } from "@scope/some-long-package-name";',
      'import { join } from "node:path/posix/whatever";',
    ].join("\n");
    expect(extractStringLiterals(src)).toEqual([]);
  });
});

describe("findDuplicates", () => {
  const sources: Record<string, string> = {
    "a.ts": 'const SIGNAL = /do you want to proceed\\?/i;\nconst ONLY_HERE = /^[0-9]{6,}$/;',
    "b.ts": 'const SIGNAL = /do you want to proceed\\?/i;',
    "c.ts": 'const DSN = "postgres://user:pass@host:5432/db";',
    "d.ts": 'const DSN = "postgres://user:pass@host:5432/db";',
  };
  const read = (f: string) => sources[f]!;
  const files = Object.keys(sources);

  test("a pattern in two files is reported with both", () => {
    const dupes = findDuplicates(files, read);
    const signal = dupes.find((d) => d.literal.includes("proceed"));
    expect(signal).toBeDefined();
    expect(signal!.files).toEqual(["a.ts", "b.ts"]);
    expect(signal!.kind).toBe("regex");
  });

  test("a pattern in one file is not reported", () => {
    const dupes = findDuplicates(files, read);
    expect(dupes.some((d) => d.literal.includes("[0-9]{6,}"))).toBe(false);
  });

  test("strings are not reported by default", () => {
    // Opt-in, because the string dimension is where the noise lives.
    expect(findDuplicates(files, read).some((d) => d.kind === "string")).toBe(false);
  });

  test("strings are reported when asked for", () => {
    const dupes = findDuplicates(files, read, { strings: true });
    const dsn = dupes.find((d) => d.kind === "string");
    expect(dsn).toBeDefined();
    expect(dsn!.files).toEqual(["c.ts", "d.ts"]);
  });

  test("an unreadable file is skipped rather than fatal", () => {
    const dupes = findDuplicates(["a.ts", "b.ts", "gone.ts"], (f) => {
      if (f === "gone.ts") throw new Error("ENOENT");
      return sources[f]!;
    });
    expect(dupes.some((d) => d.literal.includes("proceed"))).toBe(true);
  });

  test("results are ordered by how widely a literal is duplicated", () => {
    const wide: Record<string, string> = {
      "x.ts": "const A = /^aaaa[0-9]+$/;\nconst B = /^bbbb[0-9]+$/;",
      "y.ts": "const A = /^aaaa[0-9]+$/;\nconst B = /^bbbb[0-9]+$/;",
      "z.ts": "const A = /^aaaa[0-9]+$/;",
    };
    const dupes = findDuplicates(Object.keys(wide), (f) => wide[f]!);
    expect(dupes[0]!.files).toHaveLength(3);
    expect(dupes[1]!.files).toHaveLength(2);
  });
});

describe("formatReport", () => {
  test("says so plainly when there is nothing", () => {
    expect(formatReport([])).toBe("No duplicated definitions found.");
  });

  test("lists every file a literal appears in", () => {
    const out = formatReport([{ literal: "/x[0-9]+/", kind: "regex", files: ["a.ts", "b.ts"] }]);
    expect(out).toContain("/x[0-9]+/");
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });

  test("does not claim a duplicate is a defect", () => {
    // Two modules may genuinely need the same constant. The report asks; it
    // does not rule.
    const out = formatReport([{ literal: "/x[0-9]+/", kind: "regex", files: ["a.ts", "b.ts"] }]);
    expect(out).toContain("not automatically a defect");
  });
});

describe("each guard is isolated — a test that only that guard can satisfy", () => {
  // Codex's finding on this PR: the tests above would pass with PATTERN_SIGNALS
  // or TEMPLATE_MARKER deleted, because some other filter happened to reject
  // the same input. A test that cannot fail when a guard is removed does not
  // test that guard. Each case here is constructed so exactly one filter
  // stands between it and a false positive.

  test("PATTERN_SIGNALS alone rejects a long slash-delimited run", () => {
    // The first attempt at this test used a quoted path, and review showed it
    // proved nothing: the segments between slashes were under the length
    // minimum and the quote failed the preceder guard too. This one clears
    // every other filter — preceder `(`, 27 characters, no leading quote, no
    // `${` — so only the requirement that a pattern contain pattern structure
    // stands between it and a false positive.
    expect(extractRegexLiterals("fn(/usr_local_share_data_dir/)")).toEqual([]);
  });

  test("TEMPLATE_MARKER alone rejects an interpolated fragment", () => {
    // Preceder is `=`, the fragment carries `[` and `+`, and it does not start
    // with a quote. Only `${` disqualifies it.
    expect(extractRegexLiterals("const r = /x[0-9]+${n}/;")).toEqual([]);
  });

  test("the quote-led filter alone rejects string content", () => {
    // Preceder `=`, has `[` and `+`, no `${`. Only the leading quote saves it.
    expect(extractRegexLiterals(`const s = /'[0-9]+abc/;`)).toEqual([]);
  });

  test("the preceder anchor alone rejects a slash after a word character", () => {
    // Has pattern structure and no other disqualifier; what rejects it is that
    // a regex cannot follow an identifier.
    expect(extractRegexLiterals("const n = count /x[0-9]+/;")).toEqual([]);
  });

  test("MIN_REGEX_LENGTH alone rejects a short pattern in a good position", () => {
    expect(extractRegexLiterals("const R = /^\\d+$/;")).toEqual([]);
  });
});

describe("positions a pattern is legally returned from", () => {
  test("an arrow function body", () => {
    // Missed before: `=>` ends with `>`, which was not a recognised preceder,
    // so a regex handed straight back from an arrow was invisible.
    expect(extractRegexLiterals("const f = (x) => /^[a-z][a-z0-9]{3,}$/.test(x);"))
      .toEqual(["/^[a-z][a-z0-9]{3,}$/"]);
  });

  test("a throw", () => {
    expect(extractRegexLiterals("throw /^[a-z][a-z0-9]{3,}$/;"))
      .toEqual(["/^[a-z][a-z0-9]{3,}$/"]);
  });

  test("after await", () => {
    expect(extractRegexLiterals("const r = await /^[a-z][a-z0-9]{3,}$/;"))
      .toEqual(["/^[a-z][a-z0-9]{3,}$/"]);
  });

  test("but a property named await followed by division is not a pattern", () => {
    // A bare `\bawait` preceder invented `/ total[0] + offset /` here. Widening
    // the accepted positions is how a scanner finds more duplicates and also
    // how it starts making them up.
    expect(extractRegexLiterals("const x = obj.await / total[0] + offset / scale;")).toEqual([]);
  });

  test("a bare greater-than is not an arrow", () => {
    expect(extractRegexLiterals("const n = a > /x[0-9]+/;")).toEqual([]);
  });
});

describe("flags are part of the literal", () => {
  test("d and v are recognised, so a flagged pattern is not conflated with a bare one", () => {
    // Omitting them from the flag set does not skip the literal — the capture
    // ends at the slash and drops the flag, so /x/d and /x/ become the same
    // string and are reported as duplicates of each other.
    expect(extractRegexLiterals("const R = /^[a-z][a-z0-9]{3,}$/d;"))
      .toEqual(["/^[a-z][a-z0-9]{3,}$/d"]);
    expect(extractRegexLiterals("const R = /^[a-z][a-z0-9]{3,}$/v;"))
      .toEqual(["/^[a-z][a-z0-9]{3,}$/v"]);
  });

  test("differently flagged patterns are different literals", () => {
    const sources: Record<string, string> = {
      "a.ts": "const R = /^[a-z][a-z0-9]{3,}$/g;",
      "b.ts": "const R = /^[a-z][a-z0-9]{3,}$/;",
    };
    // Same body, different flags — not the same rule, and not a duplicate.
    expect(findDuplicates(Object.keys(sources), (f) => sources[f]!)).toEqual([]);
  });
});

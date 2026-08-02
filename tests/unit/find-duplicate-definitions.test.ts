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

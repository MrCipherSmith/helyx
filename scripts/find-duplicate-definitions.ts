/**
 * Report literals that carry a rule and live in more than one file.
 *
 * Six flows in a row here, the bug was one piece of knowledge duplicated and
 * quietly diverging: five ANSI strippers, a permission-dialog rule restated
 * four times, an edit-guard protocol written out three ways. Every one was
 * found by a person reading code. This finds the common case without anyone
 * having to look — including one that survived five review rounds *about that
 * very rule*, because everybody was reading the diff rather than asking what
 * remained.
 *
 * What it cannot see, so it is not mistaken for a guarantee:
 *
 * - **Paraphrase.** It compares literals. A rule restated in different words
 *   — which is exactly how the permission-dialog rule went wrong four times —
 *   is invisible to it.
 * - **Assembly.** Literals built by concatenation or template interpolation
 *   are not literals by the time they matter.
 * - It is a scan, not a parser. It reads source with regular expressions and
 *   is therefore approximate at the edges by construction.
 *
 * Patterns are reported by default and long strings are not, because the first
 * run over this repository found 138 "duplicates" of which the useful ones
 * were all patterns: the rest were import specifiers and Tailwind class lists,
 * duplicated on purpose. A report at that ratio is a report nobody reads, and
 * then the two real findings are invisible. `--strings` asks for the other
 * dimension deliberately.
 *
 * Usage:
 *   bun run dupes                  duplicated patterns, exit 0
 *   bun run dupes --strings        also long string literals
 *   bun run dupes --include-tests  include tests and fixtures
 *   bun run dupes --fail           exit 1 when anything is reported
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Below this a string is a word, not a format. Twenty-four characters is long
 * enough to exclude labels, keys and short messages, and short enough to keep
 * a connection string, a path template or a prompt fragment.
 */
const MIN_STRING_LENGTH = 24;

/** Below this a pattern is too small to be a shared rule worth naming. */
const MIN_REGEX_LENGTH = 12;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".metaproject", "graphify-out", "logs", ".claude",
]);

/** Excluded unless --include-tests: a test restating a pattern is often deliberate. */
const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures)(\/|$)|\.(test|spec)\.tsx?$/;

/**
 * A regex literal, approximately.
 *
 * The body may contain escapes and character classes — `[^\/]` must not end
 * the literal at the slash inside it — which is why those two alternatives
 * come before the plain-character one.
 *
 * The flag set includes `d` and `v`. Omitting them does not merely skip those
 * literals: the capture ends at the slash and drops the flag, so `/x/d` and
 * `/x/` become the same string and are reported as duplicates of each other.
 */
const REGEX_LITERAL = /\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\])+\/[dgimsuvy]*/g;

/** Single- or double-quoted strings, without interpolation. */
const STRING_LITERAL = /(['"])(?:\\.|(?!\1)[^\\\n])*\1/g;

/**
 * Characters a regex literal may legally follow.
 *
 * This is what separates `/^[a-z]+$/` from `a / b` and from the second slash
 * of an import path. Without it the scan reports `/memory/summarizer` and
 * `/api.telegram.org/` as duplicated patterns, which is how a checker earns
 * being ignored.
 *
 * Anchored at the end, which is the whole point: an unanchored test matched
 * the `=` in `html += "..."` and let string content through. Its own test
 * caught that.
 *
 * `>` is here for `=>`, and `throw`/`await`/`yield` for the other positions a
 * pattern is legally returned from. Without them a regex handed straight back
 * from an arrow function is invisible, which is a duplicate this tool exists
 * to find rather than a false positive it exists to avoid.
 */
const REGEX_PRECEDERS = /(?:[=(,:[!&|?{;+>]|\breturn|\btypeof|\bcase|\bthrow|\bawait|\byield)$/;

/** Something only a pattern has. A path or a URL has none of these. */
const PATTERN_SIGNALS = /[\\^$[\]+*?{}|]|\(\?/;

/**
 * Template interpolation. `\`…/bot${token}/…\`` and a division inside a
 * template both look like a regex to a scanner, and both contain `${` — which
 * no real pattern does, since `${` is not a construct a regex has.
 */
const TEMPLATE_MARKER = /\$\{/;

export interface Duplicate {
  literal: string;
  kind: "regex" | "string";
  files: string[];
}

export function collectSourceFiles(root: string, includeTests: boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  const rel = out.map((f) => f.replace(`${root}/`, "").replace(/^\.\//, ""));
  return includeTests ? rel : rel.filter((f) => !TEST_PATH.test(f));
}

/** Regex literals in one file's source, filtered to things that are actually patterns. */
export function extractRegexLiterals(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(REGEX_LITERAL)) {
    const literal = match[0];
    if (literal.length < MIN_REGEX_LENGTH) continue;
    if (!PATTERN_SIGNALS.test(literal)) continue;
    if (TEMPLATE_MARKER.test(literal)) continue;
    // A pattern does not begin with a quote; `/').pop()}</s` is string content
    // that happened to sit between two slashes.
    if (/^\/["'`]/.test(literal)) continue;

    const before = source.slice(0, match.index).trimEnd();
    if (before && !REGEX_PRECEDERS.test(before)) continue;

    found.push(literal);
  }
  return found;
}

/** A module specifier — duplicated by every file that imports the same thing. */
const MODULE_SPECIFIER = /^['"](\.{1,2}\/|@|node:)|\.tsx?['"]$/;

/**
 * String literals long enough to be a format rather than a word.
 *
 * Module specifiers are dropped: ten files importing the same manager is what
 * importing looks like, not a duplicated definition.
 */
export function extractStringLiterals(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(STRING_LITERAL)) {
    const literal = match[0];
    if (literal.length - 2 < MIN_STRING_LENGTH) continue;
    if (MODULE_SPECIFIER.test(literal)) continue;
    found.push(literal);
  }
  return found;
}

/** Literals appearing in more than one of the given files. */
export function findDuplicates(
  files: readonly string[],
  read: (path: string) => string,
  options: { strings?: boolean } = {},
): Duplicate[] {
  const seen = new Map<string, { kind: "regex" | "string"; files: Set<string> }>();

  for (const file of files) {
    let source: string;
    try {
      source = read(file);
    } catch {
      continue; // unreadable — not this tool's problem to report
    }
    const add = (literal: string, kind: "regex" | "string"): void => {
      const entry = seen.get(literal) ?? { kind, files: new Set<string>() };
      entry.files.add(file);
      seen.set(literal, entry);
    };
    for (const literal of extractRegexLiterals(source)) add(literal, "regex");
    if (options.strings) {
      for (const literal of extractStringLiterals(source)) add(literal, "string");
    }
  }

  return [...seen]
    .filter(([, entry]) => entry.files.size > 1)
    .map(([literal, entry]) => ({ literal, kind: entry.kind, files: [...entry.files].sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.literal.localeCompare(b.literal));
}

export function formatReport(duplicates: readonly Duplicate[]): string {
  if (duplicates.length === 0) return "No duplicated definitions found.";
  const lines = [`${duplicates.length} duplicated definition(s):`, ""];
  for (const d of duplicates) {
    lines.push(`  [${d.kind}] ${d.literal}`);
    for (const file of d.files) lines.push(`      ${file}`);
    lines.push("");
  }
  lines.push("A duplicate is not automatically a defect — two modules may");
  lines.push("genuinely need the same constant. It is a question, not a verdict.");
  return lines.join("\n");
}

if (import.meta.main) {
  const includeTests = process.argv.includes("--include-tests");
  const failOnFind = process.argv.includes("--fail");
  const root = process.cwd();

  const files = collectSourceFiles(root, includeTests);
  const duplicates = findDuplicates(
    files,
    (f) => readFileSync(join(root, f), "utf8"),
    { strings: process.argv.includes("--strings") },
  );

  console.log(formatReport(duplicates));
  if (failOnFind && duplicates.length > 0) process.exit(1);
}

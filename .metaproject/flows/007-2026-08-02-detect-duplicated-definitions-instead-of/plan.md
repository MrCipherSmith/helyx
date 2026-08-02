# Implementation Plan

Status: agreed

## Approach

`scripts/find-duplicate-definitions.ts`, run as `bun run dupes`.

It scans TypeScript sources for two kinds of literal that carry a rule rather
than a value — regular expressions, and string constants long enough to be a
format rather than a word — and reports any that appear in more than one file.

The naive version has a noise problem worth solving properly rather than
tuning away: a regex-shaped match is not necessarily a regex. `/memory/summ`
and `/api.telegram.org/` are import paths and URLs, and the first prototype
reported both. Two filters fix it without guessing:

- the literal must contain at least one thing only a pattern has — an anchor,
  an escape, a character class, or a quantifier;
- the character before it must be one a regex can legally follow (`=`, `(`,
  `[`, `,`, `:`, `return`, `&&`, `||`, `!`), which is what separates a literal
  from a division or a path.

Tests and fixtures are excluded by default: a test restating a pattern is
often deliberate. `--include-tests` turns that off, because the case that
started all this — `tmux-watchdog.test.ts` holding its own copy of a rule —
is exactly the one worth being able to ask about.

## Steps

1. The script, with the two filters and the exclusions.
2. Tests over synthetic sources — the detector's own parsing is the part that
   can be wrong.
3. `bun run dupes` in package.json.
4. Run it on this repository and record what it finds in the journal, including
   what is a real duplicate and what is not.
5. `bun run typecheck`, `bun run lint`, `bun test tests/unit/`.

## Risks

- **Noise kills a checker.** Anything that reports a hundred things gets
  ignored, and then the two real ones are invisible. Hence the filters, and
  hence reporting rather than failing.
- **A duplicate can be legitimate** — two modules may genuinely need the same
  constant and share nothing else. The report says where, and a human decides;
  it does not claim every hit is a defect.
- The scanner is regex over source, not a parser. It will miss literals built
  by concatenation and templates, and it should say so rather than imply
  completeness.

# Flow Journal

- 2026-08-02T20:04:57.777Z - flow created
- 2026-08-02T20:05:43.753Z - frozen: 10 criteria; checksum recorded
- 2026-08-02T20:05:43.846Z - started
- 2026-08-02T20:05:43.939Z - task-done: T1: Collect remaining context

## What it found on this repository (AC8)

Nineteen duplicated patterns after the two it caused to be fixed on this
branch. Sorted by what they mean:

### Real leftovers from earlier flows — fixed here

| Pattern | Where | Story |
|---|---|---|
| `/do you want to proceed\?/i`, `/❯\s*1[.)]\s*yes/i` | `scripts/tmux-watchdog.ts`, `utils/permission-prompt.ts` | Flow 006 switched `detectPermissionPrompt` to the shared predicate and left a second consumer forty lines below using local copies. **Five review rounds about that exact rule did not catch it**, because everyone was reading the diff. |
| `/^[a-zA-Z0-9._\-\/~^:]{1,200}$/` | `mcp/dashboard-api.ts`, `utils/request-guards.ts` | Flow 003 moved `handleGitFile`'s allowlist into the shared guard and left `handleGitDiff`'s copy behind. Three review rounds. |

Both were found by running the detector, not by anyone looking. That is the
entire argument for it.

### The next flow, handed over by the report

Twelve of the nineteen are shared by `utils/output-monitor.ts` and
`utils/tmux-monitor.ts`: `/^\? for shortcuts/`, `/^esc to interrupt/`,
`/^Enter to confirm/`, `/ctrl\+[a-z] to/`, `/^[·✶✻]\s+(.+)/`,
`/^(\w+)\((.+)\)/`, `/^Bash\((.+)\)$/`, `/^(Read|Edit|Write)\((.+)\)$/`,
`/^\S+\s*-\s*(\w+)\s*\(MCP\)/`, `/^(Explore|Agent)\((.+)\)/`,
`/^Running \d+ agents?/`, `/^[├└│][\s─]+(.+)/`.

That is not a coincidence of style — it is the whole pane-parsing rule set,
written out twice, in two files that must agree about what Claude Code's
output looks like. Exactly the shape of flow 001's five ANSI strippers and
flow 005's four restatements of one rule. Recorded as the next flow rather
than swept into this one.

### Acceptable duplicates

`/^["']|["']$/g` and `/^(\d+)(m|h|d)$/` appear twice in unrelated modules that
share nothing else. The report says where; a human decides. It does not claim
every hit is a defect, and these are the demonstration of why.

## What the detector cost to make trustworthy

The first prototype reported **138** duplicates, of which a handful were real:
import specifiers, Tailwind class lists, and divisions a scanner mistook for
patterns. Four filters brought it to 19, all genuine:

- patterns must contain something only a pattern has;
- the character immediately before must be one a regex can legally follow —
  **anchored at the end**, which its own test caught: unanchored, the `=` in
  `html += "…"` let string content through;
- `${` disqualifies a match, since no real pattern contains it;
- strings are opt-in, because that dimension is where the noise lives.

## Codex review, 2026-08-02

Verdict: REQUEST CHANGES. Three findings on the scanner, all confirmed by
running them before accepting.

| Finding | Verified | Outcome |
|---|---|---|
| The flag set `[gimsuy]` omits `d` and `v` | `/x/d` was captured as `/x/` — the flag dropped | **Fixed.** Not a skipped literal but a *conflation*: `/x/d` and `/x/` became the same string and would be reported as duplicates of each other. |
| Literals after `=>` and `throw` are missed | both returned `[]` | **Fixed.** `>` and `throw`/`await`/`yield` added. A regex handed straight back from an arrow function was invisible — a false negative in a tool whose whole job is finding copies. |
| The tests would pass against a broken scanner | confirmed by inspection: removing `PATTERN_SIGNALS` or `TEMPLATE_MARKER` leaves every existing case still rejected by some *other* filter | **Fixed.** Five tests added, each constructed so exactly one guard stands between the input and a false positive. |

The third is the one worth keeping. A test that cannot fail when a guard is
deleted does not test that guard, and until this was pointed out the suite
looked thorough while pinning almost nothing about the filters specifically.
The same class as the flow-005 tests that fed `detectPhase` raw pane text and
passed while production failed.

Codex also confirmed the two duplicate removals are behaviour-preserving,
including that `handleGitDiff` keeps `HEAD~1` rather than inheriting
`sanitizeGitRef`'s `HEAD` default.

After the fixes: 652 tests pass, the repository report is unchanged at 19.

### Second Codex pass — the fix for "tests can't fail" could not fail either

Two findings, both verified before accepting.

**Widening the preceders invented a duplicate.** A bare `\bawait` and a bare
`>` turned `obj.await / total[0] + offset / scale` into the literal
`/ total[0] + offset /`. Confirmed by running it. `=>` is now matched as a
pair, and the keywords are guarded against a preceding `.` or word character.
Both directions retested: real `await`, `=>` and `throw` positions still
found, `a > /x/` and `obj.await /…/` no longer.

Codex also cited TypeScript assertions ending in `>` as a second false
positive. That one did not reproduce — `value as Map<string, number> / 2`
returns nothing — but the narrowing removes the class regardless, so it is
fixed without having been demonstrated.

**The PATTERN_SIGNALS test still pinned nothing.** It used a quoted path whose
segments were under the length minimum and whose quote also failed the
preceder guard, so deleting `PATTERN_SIGNALS` would not have failed it.

That is the third time in this flow the same shape appeared, and the second
time inside the fix for it:

1. the original suite would have passed with two guards deleted;
2. the test written to fix that could itself not fail;
3. both were found by review, neither by me.

The replacement clears every other filter deliberately — preceder `(`, 27
characters, no leading quote, no `${` — so `PATTERN_SIGNALS` is the only thing
standing between it and a false positive. Written down here because the
lesson is not "check the guards" but "a test written to prove a guard needs
the same scrutiny as the guard".
- 2026-08-02T22:58:43.079Z - task-done: T2: Implement per plan
- 2026-08-02T22:58:43.174Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-02T22:58:43.266Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-02T22:58:44.968Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/43
- 2026-08-02T22:58:55.676Z - ac-confirmed: AC1: scripts/find-duplicate-definitions.ts runs as 'bun run dupes' and reports each literal with every file it appears in
- 2026-08-02T22:58:55.781Z - ac-confirmed: AC2: findDuplicates tests: a pattern in two files is reported with both; one in a single file is not
- 2026-08-02T22:58:55.883Z - ac-confirmed: AC3: both prototype false positives covered, plus interpolated URLs, division, division inside a template, string content between slashes, and obj.await followed by division
- 2026-08-02T22:58:55.989Z - ac-confirmed: AC4: MIN_STRING_LENGTH = 24, named with the reasoning; tested above and below the threshold
- 2026-08-02T22:58:56.095Z - ac-confirmed: AC5: TEST_PATH excludes tests and fixtures by default; --include-tests documented; collectSourceFiles takes the flag
- 2026-08-02T22:58:56.197Z - ac-confirmed: AC6: every test runs against synthetic sources; findDuplicates takes its reader as a parameter so nothing touches the repository
- 2026-08-02T22:59:19.314Z - ac-confirmed: AC7: reports and exits 0; --fail documented in the header and implemented; nothing wired into CI in this flow
- 2026-08-02T22:59:19.401Z - ac-confirmed: AC8: journal records all 19: two real leftovers fixed here (permission regexes, git-ref allowlist), twelve handed to the next flow as the pane-parsing set, and two named as acceptable
- 2026-08-02T22:59:19.484Z - ac-confirmed: AC9: bun run typecheck clean; bun run lint 0 errors (208 warnings, pre-existing); 654 unit tests pass, none skipped or removed
- 2026-08-02T22:59:19.572Z - ac-confirmed: AC10: the header names paraphrase, concatenated/template literals, and scan-not-parser as what it cannot see
- 2026-08-02T22:59:25.686Z - completing
- 2026-08-02T22:59:27.320Z - done: all gates passed

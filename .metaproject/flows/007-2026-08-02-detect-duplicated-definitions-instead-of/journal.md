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

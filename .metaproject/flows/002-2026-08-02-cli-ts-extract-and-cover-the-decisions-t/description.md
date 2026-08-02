# cli.ts — extract and cover the decisions the setup path depends on

Status: formalized
Source: user description (заход 2 of the coverage programme)

## Problem

`cli.ts` is 2082 lines at cyclomatic complexity 360 — the most complex file in
the project and the second-worst hotspot by churn × complexity (212 400,
behind only `scripts/supervisor.ts`). It cannot be imported by a test: a
top-level `switch` on `process.argv` runs on import, so every decision inside
it is currently unreachable from the unit suite. Coverage of the file is
effectively zero, and the last three production failures in this repository
all touched it.

Five decisions inside it are pure, are relied on by the install and setup
paths, and are untested. Each fails quietly rather than loudly:

1. **`parseFlags`** (`cli.ts:168`) — parses the arguments of every `helyx`
   subcommand, including the unattended install (`helyx setup --profile=minimal
   … < /dev/null`) that v1.51.0 introduced. A mis-parsed flag does not error;
   it produces a different installation than the operator asked for.
2. **`pruneStaleStopHooks`** (`cli.ts:931`) — rewrites the user's *global*
   `~/.claude/settings.json`, removing hook registrations whose script no
   longer exists. It splices arrays in a reverse loop and drops entries that
   become empty. Getting it wrong damages a file this project does not own.
3. **`isEphemeralCheckout`** (`cli.ts:917`) — the guard added in v1.52.0 that
   stops the Stop hook being registered from a temporary directory or a git
   worktree, because such a registration outlives the checkout and then points
   at a script that is gone. The path classification inside it is pure.
4. **Memory detection** (`cli.ts:275`) — three sources tried in order: cgroup
   v2 `memory.max`, cgroup v1 `memory.limit_in_bytes` (which reports an absurd
   sentinel when unlimited), then `/proc/meminfo`. Each parse is pure; a wrong
   answer here silently changes which models the wizard offers.
5. **Preset fitting** (`cli.ts:418`) — which local model presets a host can
   actually serve. Offering one it cannot is "a failure that surfaces at first
   use, long after setup reported success", in the words of the comment above
   it.

## Expected Outcome

Those five decisions live in importable modules with unit tests that exercise
the real implementations, and `cli.ts` calls them. The CLI behaves exactly as
it does today.

## Out of Scope

- Reducing `cli.ts`'s complexity as a goal in itself. It drops by whatever the
  extraction removes and no more; this flow does not restructure the wizard,
  the tmux commands, or the setup prompts.
- Making `cli.ts` importable. The top-level `switch` stays; the point is that
  the decisions no longer live behind it.
- Changing any CLI behaviour, output, prompt or default.
- The interactive prompt helpers (`ask`, `askChoice`, `askYesNo`,
  `askMultiCheck`) — they read stdin and belong to a flow that can drive it.

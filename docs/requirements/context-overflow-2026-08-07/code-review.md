# Code Review — Flow 054

Version: 1.0.0
Reviewed: 2026-08-07, the parked WIP at `0ab63da`

Four defects, all silent. Three of them are the same defect wearing different
faces: the denominator of the percentage this whole feature turns on was wrong
for every model this deployment runs, and a wrong denominator is a wrong
percentage — never an error.

## R1 — the models actually in use were not in the window table (high)

`windowFor()` matches a model id against a prefix table and falls back to
`DEFAULT_CONTEXT_WINDOW` (200 000). Neither `claude-opus-5` nor
`claude-sonnet-5` was in it — and per the `projects` table, every session on
this host runs one of them.

Both have a 1 000 000-token window. Read as 200 000, the ratio is overstated
fivefold: the 85% threshold is reached at roughly 17% of the real window. The
feature would have summarised nearly every session, nearly every tick, and the
`already-summarized` high-water gate would have masked how often by making it
look deliberate.

## R2 — a short prefix shadowed its own longer siblings (high)

The table is scanned in order and takes the first prefix that matches, and
`claude-opus-4` sat above nothing — there were no `claude-opus-4-6/7/8` entries
at all, so those three 1M models matched the bare `claude-opus-4` row and got
200 000. Same shape for `claude-sonnet-4-6` against `claude-sonnet-4`.

Ordering is now load-bearing and documented as such, and a test asserts the
property rather than the ids: any future entry placed above its own longer
sibling fails the suite.

## R3 — one entry was inverted (medium)

`claude-sonnet-4-5` was recorded as 1 000 000; its real window is 200 000. This
is the opposite error from R1 and the worse one to debug: too *large* a
denominator understates the ratio, so the threshold is never crossed and the
feature simply never runs. `utils/context-usage.ts` names this exact failure in
its own comment on `DEFAULT_CONTEXT_WINDOW` — "too large never fires it at all,
which costs the feature" — and then shipped an instance of it.

Windows for all three are from the Claude API model reference rather than
memory. The 4.x line is not uniform — Opus 4.6/4.7/4.8 and Sonnet 4.6 are 1M
while Opus 4.5/4.1 and Sonnet 4.5 are 200k — which is how the wrong ones got
written down in the first place.

## R4 — one setting, two behaviours (medium)

`CONTEXT_SUMMARY_THRESHOLD` had two readers that disagreed about what an
out-of-range value means. `config.ts` validated it with `z.coerce.number()
.min(0.5).max(0.99)`, and an invalid environment makes that file
`process.exit(1)`. `scripts/supervisor.ts` clamped the same variable into the
same range and carried on.

So `CONTEXT_SUMMARY_THRESHOLD=0.3` — an operator typo — takes the bot container
down at startup while the supervisor runs happily at 0.5. Same variable, one
outage and one shrug.

Both now call `contextThreshold()`. Clamping is the half worth keeping: the
value is an operator preference, not a correctness invariant, and refusing to
start over one helps nobody. This is the repository's own recorded
known-mistake — *one rule in several files diverges, and review does not catch
it* — and it is why the fix is a shared function rather than two matching
literals.

## What held

- The arithmetic. `contextTokens()` sums the three usage fields and returns
  null rather than zero for an entry that carries none — the distinction the
  loop depends on, and one a naive implementation gets wrong.
- The once-per-crossing gate. A session parked at 90% is one crossing, not one
  every tick; only growth past the high-water mark is a new one.
- The idle gate. A busy session at the threshold is left for the next tick
  rather than interrupted mid-turn.
- The hook endpoint: loopback-only, transcript path validated, bounded by a
  timeout, and answering 200 in every case including the timeout — because the
  fold is waiting on the response and a hook that blocks compaction is worse
  than a hook that does nothing.
- `scripts/pre-compact-hook.sh` exits 0 on every path.
- The wizard registration prunes stale entries the same way the `Stop` and
  `PreToolUse` installers do.

## Gate

`bun run typecheck` clean · `bun run lint` 0 errors · `bun test tests/unit/`
1960 pass, 0 fail.

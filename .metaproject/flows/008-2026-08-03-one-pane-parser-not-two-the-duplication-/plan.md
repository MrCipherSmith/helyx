# Implementation Plan

Status: agreed

## Approach

`utils/pane-parse.ts` holds the parser: the chrome list, `isChrome`,
`parseLine` and `parseStatus`. Both monitors import it and keep only what is
genuinely theirs — tmux capture on one side, file tailing on the other.

The three drifts are resolved rather than preserved:

- **ANSI stripping happens always.** `stripAnsi` on already-clean text is a
  no-op, so unifying costs nothing and fixes the latent bug on the tmux side,
  where every `^`-anchored pattern currently fails on a line that begins with
  an escape. This is the one behaviour change, and it is in the direction flow
  001 already established.
- **The extra skip patterns become a parameter.** `output-monitor` passes the
  `script` header and footer. `/^\x1b/` is dropped rather than carried: it
  cannot match, because the line is stripped before `isChrome` sees it.
- **The `Error:` branch order is unified** — the outcome is identical either
  way, since no earlier branch can match a line starting `Error:`, and a test
  records that rather than leaving it to be re-derived.

Per `shared-definitions`: the copies go in the same change, and every
consumer is checked rather than trusting the import list.

## Steps

1. `utils/pane-parse.ts` with the four pieces and the options parameter.
2. Rewire `tmux-monitor.ts` and `output-monitor.ts`; delete both copies.
3. Tests for the parser — it has almost none today; `parseStatus` is reached
   only by flow 005's contract test.
4. Verify.

## Verification (tracked as flow tasks, not as prose)

Flow 005 listed its verification as step 5 of a plan, skipped it, and shipped
a change that could not work. These are tasks so `flow complete` gates on
them:

- T5: `bun run dupes` no longer reports any pattern shared by the two
  monitors, and the total drops by twelve.
- T6: the status block for a captured pane is byte-identical before and after,
  compared against real recorded output rather than a hand-written sample.

## Risks

- **`parseStatus` output feeds the status line**, which is compared by
  signature to suppress duplicate edits. A change of even one character in the
  rendering makes every status appear new once. T6 exists for this.
- Stripping ANSI on the tmux path changes what matches. That is the intended
  fix, and it can only turn a failed match into a successful one — but "more
  lines now parse" is itself a visible change, which T6 will show.

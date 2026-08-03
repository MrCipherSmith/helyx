# What is worth remembering

Status: formalized

## Problem

Two heuristics inside `memory/summarizer.ts` decide whether a conversation
leaves any trace at all, and neither could be reached from a test.

`isContentTrivial` decides whether to summarise. `isSummaryWorthSaving` decides
whether to keep what was produced. Between them they are the most consequential
unwatched code in the project — and their failure is silent by construction.
A wrong "this is trivial" drops a conversation with no summary and tells nobody;
the fact is simply not there the next time someone looks for it, and its absence
is indistinguishable from never having discussed it.

The costs are asymmetric and point in opposite directions. Keeping something
worthless costs a few tokens. Dropping something needed costs a fact nobody
knows is missing. Saving a bad summary is worse still: a wrong fact recalled
with confidence.

## Expected Outcome

`utils/memory-triage.ts` holds both decisions with their thresholds named, and
`memory/summarizer.ts` uses them. The tests pin the behaviour as it is,
including two properties that are risks rather than features:

- A conversation with fewer than two user messages is *always* trivial. A single
  long message stating a constraint is discarded whole.
- The empty-summary patterns are unanchored, so a real summary that happens to
  contain "no changes" is thrown away.

Both are recorded rather than quietly changed. Changing either is a decision
about how much noise the memory should carry, not a fix to slip into a test pass.

## Out of Scope

The rest of `memory/summarizer.ts` is I/O — the LLM call, the database writes,
the transcript reader. Covering it wants a module fake for `claude/client.ts`,
which is the next flow rather than this one.

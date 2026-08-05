# The summarizer produced nothing for weeks and nothing tested it

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C3)

## Problem

`memory/summarizer.ts` decides what the system remembers: it compacts an idle
session, extracts durable project knowledge, and writes both to long-term
memory. 322 of its 390 instrumented lines are uncovered — 17.44%.

It is also the file that held defect D1 of this programme. For weeks
`extractFactsFromTranscript` resolved a host path inside a container, logged
`file not found` 4136 times and saved nothing, and the only thing that noticed
was a person reading the log by accident. A test of that function would have
failed on the first run.

The uncovered mass:

| Region | Uncovered |
|---|---|
| `summarizeWork` | 102 |
| `trySummarize` | 92 |
| `extractProjectKnowledge` | 59 |
| `touchIdleTimer` | 17 |
| `summarizeOnDisconnect` | 12 |
| `cleanupStaleTimers` | 11 |

## Expected Outcome

- `memory/summarizer.ts` at or above 60% of lines.
- The paths that decide whether anything is written at all are covered: a
  session with too little to say, a model that will not answer, a summary not
  worth keeping.
- The idle timer's lifecycle is tested — set, replaced, cleared — because a
  timer left behind is a summary written for a session that ended.

## Out of Scope

- Changing what is summarized or what counts as a durable fact.
- The triage helpers in `utils/memory-triage.ts`, which are pure and already
  tested.

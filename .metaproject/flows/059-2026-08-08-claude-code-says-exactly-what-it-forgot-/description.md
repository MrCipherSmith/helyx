# Claude Code says exactly what it forgot, and nobody reads it

Status: formalized
Source: investigation on 2026-08-08, after flow 054 (PR #100) shipped

## Problem

Flow 054 was built on a premise that turns out to be false. It assumed that when
Claude Code compacts its context, the material is gone and must be captured
first — so it learns the context window, watches a threshold, races the fold,
and optionally types `/compact` itself.

Claude Code does not clear its transcript. The JSONL under
`~/.claude/projects/<slug>/<uuid>.jsonl` only grows. Nothing is destroyed by a
fold, and there is nothing to race.

What it does instead is announce the fold, in the same file, in a form built to
be read. Verified against `6d61a7aa-…jsonl` in this project, lines 8103 and
13000:

```
type: "system", subtype: "compact_boundary", content: "Conversation compacted"
compactMetadata: {
  trigger: "auto",
  preTokens: 999841, postTokens: 13608, cumulativeDroppedTokens: 986233,
  durationMs: 119544,
  preservedSegment: { headUuid, anchorUuid, tailUuid },
  preservedMessages: {...},
  preCompactDiscoveredTools: [...]
}
```

Three consequences.

**The dropped span is exactly identifiable.** Everything from the previous
boundary (or the file's start) up to `preservedSegment.headUuid` is precisely
what left the model's head and stayed on disk. Not "roughly the last N
kilobytes" — that span, by uuid.

**It is the half worth keeping.** What flow 054 summarises is the `messages`
table in Postgres: the Telegram conversation. Those rows survive the fold, and
survive tomorrow. The terminal side — what the session read, tried and decided
— is the part that leaves the model, and nothing captures it.

**A fold takes two minutes.** `durationMs` was 119544 and 149137 on the two
observed boundaries. For that time the session answers nothing, which is what
reads as a hang, and it is within sight of the five-minute response guard.

And none of it is used: as of 2026-08-08 a search over `*.ts` finds no
occurrence of `compact_boundary` or `compactMetadata`. The signal sits in a file
`channel/status.ts` already tails continuously, through
`utils/transcript-monitor.ts`, and the tail walks straight past it.

## Expected Outcome

- The boundary is recognised where the transcript is already being read.
- The span the model lost is extracted by uuid and written to long-term memory,
  attached to its project and session, so it can be recalled later.
- The two minutes of a fold are visible as what they are, rather than as
  silence, and the response guard does not read them as a dead session.
- The Telegram summary stays where it is: the short-term layer, unchanged.

## Out of Scope

- Removing flow 054's threshold machinery. It is now only needed to fold
  *earlier* than Claude Code would on its own, which is a separate decision and
  not this flow's to make.
- Turning `CONTEXT_AUTO_COMPACT` on. It stays off until `busy` means "the
  session is idle" rather than "no Telegram turn is in flight".
- Re-injecting the recovered span into the session after a fold. Recall already
  reaches long-term memory through `buildContextBlock`; whether a fold should
  push more than that is a question for after this lands.

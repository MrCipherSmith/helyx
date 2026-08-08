# Implementation Plan

Status: ready

## Approach

Read the boundary where the file is already being read, and do the work after
it, not before it.

The parsing is pure and goes in `utils/context-usage.ts`, beside the `/context`
report parser that already lives there and has the same shape: a function that
takes transcript lines and returns either a typed record or null. That is the
part with edge cases, so it is the part that gets tests without a disk.

The capture is a reaction, not a poll. `utils/transcript-monitor.ts` already
delivers new lines to `channel/status.ts`; a boundary is one more kind of line
it can recognise. Nothing new tails anything.

The extraction is the only piece that touches the disk twice: on a boundary, the
span from the previous boundary to `preservedSegment.headUuid` is read out of
the same file and handed to long-term memory. Deliberately *not* summarised
through the aux model first — the span is what was lost, and a summary of it is
a second, lossier artefact. Whether to also summarise is a later decision;
storing it is the thing that cannot be done later, because a human reading the
file is not a system remembering it.

The two-minute silence is not a bug to fix but a fact to report. The status
message already exists; a fold gets a state in it.

## Steps

1. `parseCompactBoundary(line)` in `utils/context-usage.ts` — returns
   `{ trigger, preTokens, postTokens, droppedTokens, durationMs, headUuid,
   tailUuid }` or null. Tolerant: a boundary from a future CLI version with
   fields missing is still a boundary, and a line that merely contains the words
   is not one.
2. `droppedSpan(path, fromUuid, toUuid)` in `utils/transcript-locate.ts` —
   reads the records between two uuids. Bounded by the same byte budget the rest
   of the module respects; a span larger than it is truncated with that said
   explicitly, not silently.
3. `channel/status.ts` recognises the boundary in the lines it already receives,
   and hands the span to `remember()` with `type: "transcript"`, the project
   path, the session id, and the boundary's metadata as tags.
4. The status message gains a folding state, so two minutes of silence read as
   "сворачивает контекст" rather than as nothing.
5. The response guard learns that a session inside a fold is not a hung one —
   it has an explicit reason to wait, and `durationMs` from the previous
   boundary is a better estimate than a fixed timeout.
6. Tests for 1 and 2 against fixture transcripts, including two boundaries in
   one file, a boundary as the very first record, and a truncated final line.

## Risks

- **The format is not ours.** Everything here reads a private file written by
  another program, which can change it in any release. Hence step 1 returning
  null rather than throwing, and hence the span being stored raw: if the
  metadata shape changes, we lose the capture, not the session.
- **Size.** A dropped span can be most of a million tokens. Step 2's budget is
  the thing that keeps this from putting a 20 MB blob through an embedding call,
  and the truncation has to be visible in what is stored.
- **Duplicate capture.** A boundary already processed must not be captured again
  on the next poll, or every tick re-embeds the same span. The boundary's own
  `tailUuid` is the natural idempotency key.
- **Not every fold is ours to see.** A session that folds while the channel is
  down leaves a boundary nobody read. Recovering those on startup is possible —
  the file is still there, which is the whole point of this flow — but it is not
  in the first cut.

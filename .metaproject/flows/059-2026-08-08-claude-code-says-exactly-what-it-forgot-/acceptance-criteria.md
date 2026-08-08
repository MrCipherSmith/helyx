# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `parseCompactBoundary` returns the trigger, pre/post/dropped token counts, duration and the preserved segment's head and tail uuids from a real `compact_boundary` line, and returns null for any line that is not one — including a line that merely contains the words.
- AC2: A boundary whose `compactMetadata` is missing fields a future CLI version might drop is still recognised as a boundary, with the absent fields null, rather than discarded or thrown on.
- AC3: `droppedSpan` returns the records between two uuids in file order, and when the span exceeds the module's byte budget it is truncated with the truncation stated in what is returned, not silently.
- AC4: On a boundary appearing in the lines `channel/status.ts` already receives, the dropped span is written to long-term memory carrying its project path, session id and the boundary's metadata.
- AC5: The same boundary is never captured twice, however many times the transcript is polled afterwards.
- AC6: While a session is inside a fold, the status message says so, and the response guard does not report that session as hung for the duration of the fold.
- AC7: Nothing in this flow changes what the Telegram summariser reads or when it runs, and `CONTEXT_AUTO_COMPACT` remains off by default.
- AC8: `bun run lint`, `bun run typecheck` and `bun test tests/unit/` all pass, and CI is green on the pushed branch.

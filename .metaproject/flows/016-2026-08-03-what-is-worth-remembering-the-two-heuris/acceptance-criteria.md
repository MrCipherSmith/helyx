# Acceptance Criteria

## Criteria

- AC1: `utils/memory-triage.ts` exports `isContentTrivial`, `isSummaryWorthSaving` and `timerKey`, with every threshold a named constant.
- AC2: `memory/summarizer.ts` uses them and holds no copy of either heuristic.
- AC3: The tests assert each threshold at its boundary rather than well inside it.
- AC4: The single-message rule is asserted explicitly, with a comment saying it is a pinned risk rather than an endorsed behaviour.
- AC5: Whitespace padding is asserted not to buy a short message past the threshold.
- AC6: Only user messages count towards triviality — an assistant's output is not evidence a conversation happened.
- AC7: The acknowledgement pattern is asserted anchored, and the emptiness patterns unanchored, including the case where that discards a real summary.
- AC8: `timerKey` is asserted to distinguish both the session and the chat.
- AC9: `buildWorkSessionPrompt` is covered: both halves reach the prompt, long content is truncated, a tool call with no response is not rendered as an empty result, and the section headers the extractor depends on are present.
- AC10: `bun run typecheck`, `bun run lint`, `bun test` pass; `dupes` reports the two documented pairs; `utils/memory-triage.ts` is at 100% lines.

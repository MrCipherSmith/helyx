# Acceptance Criteria

## Criteria

- AC1: `utils/status-render.ts` holds the rendering, and `channel/status.ts` uses it rather than carrying its own copy.
- AC2: Multi-line activity renders as an expandable blockquote; a single line renders without one.
- AC3: The pane renders inside `<pre>`, so terminal alignment survives.
- AC4: The activity window is fifteen lines and the pane nine, up from ten and six; the per-line clipping in `utils/pane-parse.ts` is widened by half.
- AC5: When there is more content than fits, the *newest* lines survive — the operator is watching what is happening now.
- AC6: A line too long to fit at all is truncated rather than dropped.
- AC7: The statistics half shows the question being worked on, previewed if long, collapsed to one line, and HTML-escaped.
- AC8: Everything not written by this project is escaped: activity, pane and question.
- AC9: A flood of activity, pane and a long question still produces a message under Telegram's 4096-character limit.
- AC10: With no question and no tools, no empty statistics section is emitted.
- AC11: `bun run typecheck`, `bun run lint` and `bun test` pass; `dupes` reports the two documented pairs.

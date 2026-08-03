# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/skill-format.ts` exports the skill-name predicate and the inline-shell token, and `bot/callbacks.ts`, `utils/skill-distiller.ts` and `utils/skill-handlers.ts` all use it with no local copy.
- AC2: `utils/duration.ts` exports `parseDuration` returning milliseconds; `bot/commands/tmux-log.ts` and `scripts/tmux-session-logger.ts` use it and neither retains the pattern or its own arithmetic.
- AC3: `utils/llm-output.ts` exports `stripReasoning`; `claude/client.ts` and `scripts/supervisor.ts` use it with no local copy.
- AC4: `bun run dupes` reports exactly one duplicate, and it is the `unquote` idiom.
- AC5: Both `unquote` sites carry a comment stating the duplication is deliberate and why connecting them would be wrong.
- AC6: `parseDuration` is tested with the expected millisecond value stated for each unit, not by comparing implementations, plus rejection of a malformed value.
- AC7: The skill-name predicate is tested for the boundary cases the pattern encodes: leading character, allowed characters, and the 64-character limit.
- AC8: `stripReasoning` is tested for a block, several blocks, a block spanning lines, and text with none.
- AC9: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC10: The three behaviours are unchanged at the call sites: a rejected rename is still rejected with the same message, a duration parses to the same milliseconds, and a `<think>` block is removed identically.

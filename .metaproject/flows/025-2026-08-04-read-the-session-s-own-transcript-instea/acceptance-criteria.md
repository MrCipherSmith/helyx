# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The transcript file is found by matching the `cwd` recorded inside it against the project path, never by reproducing Claude Code's directory-name encoding; a fixture directory holding decoy project dirs and a decoy file for a different `cwd` resolves to the right file, and an unmatched project path resolves to null.
- AC2: A first attach starts at end of file: given a fixture transcript already holding many entries, the first poll emits no lines from what was written before the monitor started.
- AC3: The tail keeps a byte offset across polls, carries an unterminated trailing line into the next poll instead of parsing half an object, and resets the offset when the file shrinks or is replaced.
- AC4: `thinking`, `text`, `tool_use` and `tool_result` each produce a display line; an unparseable line, an unknown entry type and an entry with no recognisable content each produce no line and no throw.
- AC5: Emitted lines keep the vocabulary the existing consumers read — a `tool_use` for a file tool yields `● Read|Write|Edit: <path>`, a result yields `  └ …`, and token usage yields text matching `scrapeTokenInfo`'s `↓ <n> tokens` — proven by feeding the emitted lines through `detectPhase` and `scrapeTokenInfo` and asserting the answers.
- AC6: The monitor exposes the same `{ stop() }` handle as the tmux and output monitors, is tried first in `startProgressMonitorForChat`, and returns null when no transcript resolves so the existing tmux and output fallbacks run unchanged.
- AC7: `scripts/run-cli.sh` is unchanged and no CLI flag is added, so a session already running does not need to be restarted for the deploy.
- AC8: Subagent entries (`isSidechain: true`) are visibly distinguished from the main thread, and the rendered buffer is bounded so a wide fan-out cannot grow the message without limit.
- AC9: Full gate green — `bun run typecheck` clean, `bun run lint` 0 errors, `bun test tests/unit/` passes with the new tests included.

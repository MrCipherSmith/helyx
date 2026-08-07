# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `contextTokens()` returns `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from a transcript entry's `message.usage`, and null when the entry carries no usage.
- AC2: `windowFor()` returns the context window for the known models and a documented default for an unknown one; the default is a single named constant, not a literal at a call site.
- AC3: The supervisor loop summarises a session whose ratio is at or above the threshold only when that session is idle; a busy session at the threshold is not summarised on that tick.
- AC4: A session is summarised once per crossing, not once per tick — a second tick at the same or higher ratio does not call the summariser again.
- AC5: `POST /api/hooks/pre-compact` runs the summariser under a bounded timeout and returns a response in every case, including when the summariser exceeds the timeout.
- AC6: `scripts/pre-compact-hook.sh` exits 0 in every path, including when the bot is unreachable, so compaction is never blocked by it.
- AC7: The setup wizard registers the `PreCompact` hook and prunes stale registrations pointing at a script that no longer exists, matching the behaviour of the `Stop` and `PreToolUse` installers.
- AC8: The threshold and the default window are configurable in `config.ts` with documented defaults, and the loop logs the ratio together with the window it used.
- AC9: `bun test tests/unit/` passes with new tests covering AC1-AC5 and AC7.

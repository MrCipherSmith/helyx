# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `localTranscriptPath` returns the given path unchanged when it exists, so a host process and every existing test are unaffected; proved by test.
- AC2: `localTranscriptPath` re-roots a host path at the configured config root when the original does not exist and the re-rooted one does, reproducing the container case `/home/<user>/.claude/projects/<slug>/<id>.jsonl` → `/host-claude-config/projects/<slug>/<id>.jsonl`; proved by test.
- AC3: `localTranscriptPath` returns null when neither candidate exists, and when the path contains no `/.claude/` segment; proved by test.
- AC4: A re-rooted candidate whose carried segment contains `..` is rejected rather than returned, so the derived path cannot escape the config root; proved by test.
- AC5: `extractFactsFromTranscript` reads a transcript that exists only under the config root, and returns without warning; proved by test with a temporary directory standing in for the root.
- AC6: `extractFactsFromTranscript` falls back to `resolveTranscript(projectPath)` when translation fails, and still warns and returns 0 when that also finds nothing; proved by test.
- AC7: `deliverTurnSummary` reads a transcript that exists only under the config root, and still returns silently — no throw — when the path cannot be resolved at all; proved by test.
- AC8: No behaviour of the two consumers changes on a host process where the original path exists; the existing tests for both continue to pass unmodified.
- AC9: Whole unit suite green and `tsc --noEmit` clean.
- AC10: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC11: Every reviewer round on the draft PR ends with no unresolved finding.

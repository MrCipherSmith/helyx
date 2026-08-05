# Flow Journal

- 2026-08-04T22:16:41.006Z - flow created
- 2026-08-04T22:19:53.518Z - task-added: T5: transcript-locate: resolve by cwd match, tail by offset
- 2026-08-04T22:19:53.604Z - task-added: T6: transcript-events: entry to display line, existing vocabulary
- 2026-08-04T22:19:53.691Z - task-added: T7: transcript-monitor: poll loop, ring buffer, stop handle
- 2026-08-04T22:19:53.777Z - task-added: T8: wire into StatusManager ahead of tmux, keep fallbacks
- 2026-08-04T22:19:53.861Z - task-added: T9: raise ACTIVITY_LINES, leave the character budget alone
- 2026-08-04T22:19:53.947Z - task-added: T10: tests: fixtures with decoys, truncated write, oversized file, unknown entry
- 2026-08-04T22:19:54.035Z - task-added: T11: full gate: typecheck, lint, unit suite
- 2026-08-04T22:20:27.288Z - frozen: 9 criteria; checksum recorded
- 2026-08-04T22:20:27.372Z - started

## Notes

### A comment terminator inside a doc comment

`/** Every \`*.jsonl\` under \`<root>/projects/*/\` … */` ends the block comment at
the `*/` inside the backticks. Everything after it parsed as code, and the first
error `tsc` reported was thirty lines further down, in prose. Worth remembering
because the symptom points nowhere near the cause. Rephrased rather than escaped.

### Mutation-checked, not just green

Three deliberate mutations, each reverted:

| Mutation | Failures |
|---|---|
| `TranscriptTail.atEnd` starts at offset 0 | 5 |
| the unterminated trailing line is dropped instead of held | 1 |
| resolution derives the slug instead of matching the file's `cwd` | 10 |

The third is the one worth the trouble: derivation passes every test that uses a
predictable path and fails only on the decoy, which is exactly how it would have
failed in production.

### A disagreement left standing, on purpose

`utils/tools-reader.ts:53` computes the same config root and falls back to the
literal `/host-claude-config`; `transcript-locate.ts` falls back to `~/.claude`.
They disagree because tools-reader only runs inside the container while this also
runs under tests and on a host. Not unified: changing tools-reader's fallback
changes what it finds on a developer's machine, which is outside this flow's
frozen criteria. The disagreement is stated in the code rather than papered over
with a comment claiming agreement — see the `comment-asserts-more-than-code`
memory this flow was initialised with.

### Adjacent, not touched

`utils/claude-usage.ts` already reads these same JSONL files, for per-model cost
across *all* projects. Different question, different scan, no shared "which file
belongs to this project" knowledge — so no duplication to remove.
`utils/stream-json-parser.ts` remains dead code: it parses the `--print`
wire format, which this flow established cannot be produced by an interactive
session. Removing it is a separate decision.
- 2026-08-04T22:30:04.300Z - task-done: T1: Collect remaining context
- 2026-08-04T22:30:04.388Z - task-done: T2: Implement per plan
- 2026-08-04T22:30:04.474Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-04T22:30:04.560Z - task-done: T5: transcript-locate: resolve by cwd match, tail by offset
- 2026-08-04T22:30:04.646Z - task-done: T6: transcript-events: entry to display line, existing vocabulary
- 2026-08-04T22:30:04.735Z - task-done: T7: transcript-monitor: poll loop, ring buffer, stop handle
- 2026-08-04T22:30:04.823Z - task-done: T8: wire into StatusManager ahead of tmux, keep fallbacks
- 2026-08-04T22:30:04.908Z - task-done: T9: raise ACTIVITY_LINES, leave the character budget alone
- 2026-08-04T22:30:04.996Z - task-done: T10: tests: fixtures with decoys, truncated write, oversized file, unknown entry
- 2026-08-04T22:30:05.082Z - task-done: T11: full gate: typecheck, lint, unit suite
- 2026-08-04T22:31:13.737Z - task-added: T12: keep the completion summary's line counts working on the transcript path
- 2026-08-04T22:32:20.768Z - task-done: T12: keep the completion summary's line counts working on the transcript path
- 2026-08-04T22:32:20.864Z - ac-confirmed: AC1: resolveTranscript reads each candidate's own cwd (transcript-locate.ts:declaredCwd); tests/unit/transcript-reader.test.ts puts a decoy under the exact directory name a slug derivation would produce and the real file under one it never would — resolution picks the real one; unmatched project path returns null
- 2026-08-04T22:32:20.950Z - ac-confirmed: AC2: TranscriptTail.atEnd seeds the offset with the file size; 'a first attach does not replay what was already written' asserts the pre-existing entry never appears and the next-appended one does. Mutating atEnd to offset 0 fails 5 tests
- 2026-08-04T22:32:21.037Z - ac-confirmed: AC3: offset carried in TranscriptTail; 'an unterminated line is held' splits an object across two appends and asserts one whole line; 'a file that shrank is read from the start' and 'a fragment from a replaced file is not spliced' cover the reset. Dropping the held partial fails 1 test
- 2026-08-04T22:32:21.124Z - ac-confirmed: AC4: renderBlock covers all four block types; test.each over attachment/mode/permission-mode/last-prompt/queue-operation/system/unknown-type/no-type/null asserts no lines and no throw; parseEntry returns null for a half-written line, a bare array and a number
- 2026-08-04T22:32:32.119Z - ac-confirmed: AC5: the 'existing consumers still understand these lines' block feeds produced lines back through the real detectPhase and scrapeTokenInfo and through accumulateTurnActivity's and accumulateStats' own patterns; mutating resolution or vocabulary surfaces here
- 2026-08-04T22:32:32.207Z - ac-confirmed: AC6: startTranscriptMonitor returns { stop() } and null when attach fails; channel/status.ts:1063 tries it first when projectPath is set and falls through to startTmuxMonitor then startOutputMonitor unchanged
- 2026-08-04T22:32:32.298Z - ac-confirmed: AC7: git diff touches channel/index.ts, channel/status.ts, utils/status-render.ts, docs/dev/modules.md only; scripts/run-cli.sh unchanged, no CLI flag added, transcript is read from a file the running session already writes
- 2026-08-04T22:32:32.385Z - ac-confirmed: AC8: renderEntry prefixes sidechain lines with SIDECHAIN_PREFIX; 'the buffer is bounded' pushes 50 sidechain entries into a 5-line buffer and asserts 5 lines, the newest present, and the marker visible
- 2026-08-04T22:32:32.474Z - ac-confirmed: AC9: bun run typecheck clean; bun run lint 206 problems 0 errors (unchanged from the pre-flow baseline); bun test tests/unit/ 1288 pass 0 fail across 63 files, up from 1284/61 before the new suites
- 2026-08-04T22:32:45.216Z - ac-confirmed: AC9: bun run typecheck clean; bun run lint 206 problems 0 errors, the same count as before this flow; bun test tests/unit/ 1288 pass 0 fail across 63 files, up from 1217 across 61 at the start of the flow
- 2026-08-04T22:42:09.851Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-04T22:42:11.860Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/61
- 2026-08-04T22:42:12.014Z - completing
- 2026-08-04T22:42:13.774Z - completion-failed: pull-request: PR checks not green
- 2026-08-04T22:43:45.470Z - implemented: draft PR: https://github.com/MrCipherSmith/helyx/pull/61
- 2026-08-04T22:43:45.560Z - completing
- 2026-08-04T22:43:47.263Z - done: all gates passed

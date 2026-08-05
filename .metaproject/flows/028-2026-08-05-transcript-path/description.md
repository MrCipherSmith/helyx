# Fact extraction resolves a host path inside the container and has never run

Status: formalized
Source: user description → package `docs/requirements/self-observability-2026-08-05` (defect D1)

## Problem

The Stop hook posts `{ transcript_path, project_path }` to the bot's HTTP
server. `transcript_path` is a host path — `/home/<user>/.claude/projects/<slug>/<id>.jsonl`
— because the Claude Code session runs on the host. The bot runs in a
container, where the host config is mounted at `HOST_CLAUDE_CONFIG`
(`/host-claude-config` in `docker-compose.yml`) and `/home/<user>` does not
exist. Verified with `ls` inside `helyx-bot-1`.

Two consumers read that path, and both have therefore never worked in a
container deployment:

- `extractFactsFromTranscript` (`memory/summarizer.ts:430`) takes the
  `existsSync` branch, logs `extractFactsFromTranscript: file not found` and
  returns 0. `logs/bot.log` holds 4136 such lines.
- `deliverTurnSummary` (`mcp/server.ts:308`) reads with `readFileSync`, catches,
  and returns. Its failures are silent by design — "a courtesy at the end of
  work that already succeeded" — so it left no trace at all.

The translation both need already exists and is tested: `claudeConfigRoot()` in
`utils/transcript-locate.ts:64`, written for the status monitor, which reads the
same files correctly from the same container.

## Expected Outcome

- Both consumers resolve a host transcript path to whatever the current process
  can actually read, and work unchanged when the process *is* on the host
  (tests, a host-run bot).
- `extractFactsFromTranscript: file not found` stops being the normal outcome;
  it remains the outcome for a path that genuinely cannot be resolved.
- No new trust: the translation derives a path from the one already validated by
  `isAllowedTranscriptPath`, and cannot be steered outside the config root.

## Out of Scope

- Changing what facts are extracted, or the turn summary's content and routing.
- The `resolveTranscript` scan as a fallback for `deliverTurnSummary` — that
  function runs at the end of every turn and must stay cheap; the scan is used
  only by the session-end path.
- Backfilling facts from the 4136 sessions whose transcripts were never read.

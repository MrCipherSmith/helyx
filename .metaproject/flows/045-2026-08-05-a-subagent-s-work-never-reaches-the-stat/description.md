# A subagent's work never reaches the status

Status: formalized
Source: operator, 2026-08-05 — the same report as flow 044, and the half of it
that a continuation status alone would not fix.

## Problem

The status reads the session's own transcript (PR #61). A subagent does not
write to it.

Checked against real files: a subagent's record lives at
`~/.claude/projects/<project>/<session-uuid>/subagents/agent-<id>.jsonl`, with
`agent-<id>.meta.json` beside it carrying `agentType`, `description` and
`spawnDepth`. `listTranscripts` (`utils/transcript-locate.ts:132`) reads
`projects/<dir>/*.jsonl` — one level, files only. The subagent files are two
levels deeper and are never seen.

So while a fan-out runs, the parent transcript receives nothing until the tool
returns. The status is not wrong; it is motionless, which reads as hung. Flow
044 keeps the status alive through it; this flow gives it something to say.

## Expected Outcome

- While subagents run, their work appears in the status, each line marked with
  which agent produced it.
- A fan-out of several agents does not crowd out the parent's own lines or grow
  without bound.

## Out of Scope

- Nested fan-out beyond the depth `spawnDepth` reports; the marker carries the
  depth rather than the tree.
- Whatever the subagent returns — that is the parent's transcript, already read.

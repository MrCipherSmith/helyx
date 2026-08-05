# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Given a parent transcript path, the subagent files beside it are located at `<dir>/<uuid>/subagents/agent-*.jsonl`, proved by test over a fake tree.
- AC2: A subagent file older than the turn's start is not read, proved by test.
- AC3: A subagent's lines reach the status while it is running, proved by test.
- AC4: Each subagent line carries a label from its `meta.json` — `agentType`, else the description's first words, else the agent id — proved by test including a missing and a malformed `meta.json`.
- AC5: At most `MAX_TRACKED_AGENTS` subagents are tailed at once, and the newest win, proved by test.
- AC6: The parent's own lines are never crowded out entirely by a fan-out, proved by test.
- AC7: A subagent that has stopped growing is dropped rather than tailed for ever, proved by test.
- AC8: The location and labelling logic is a module of its own, tested directly, with file access injected.
- AC9: No test in this flow reads the operator's real `~/.claude` directory or waits on a real subagent.
- AC10: `utils/transcript-monitor.ts` and the new module's line coverage are measured and recorded.
- AC11: Whole unit suite green, `tsc --noEmit` clean, and the change recorded in `CHANGELOG.md`.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

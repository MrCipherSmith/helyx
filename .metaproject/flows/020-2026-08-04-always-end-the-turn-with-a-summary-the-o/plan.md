# Plan

## 1. The summary

`scripts/save-session-facts.sh` already posts `transcript_path` and
`project_path` to `/api/hooks/stop` at the end of every turn, and
`mcp/server.ts:590` already receives them — it only extracts memory facts.
The delivery hook is therefore already in place; what is missing is the
delivery.

- A pure `utils/turn-summary.ts`: read the transcript tail, find the final
  assistant text, decide whether a reply already went out this turn, and format
  what to send. Pure so it is testable without a transcript on disk.
- The handler resolves the project's topic from `projects.forum_topic_id` — the
  same lookup `reply` does — and sends there. A summary in General is a summary
  the operator does not read.
- Marked as bot-sent, so a forwarded summary never reads as something the
  session chose to say.

## 2. The guard

`hasOpenQuestion(sql, sessionId)` already exists in `services/ask-question.ts`.
The guard consults it before announcing silence, and re-arms quietly instead.

## 3. The pane

`utils/pane-parse.ts` already recognises interactive prompts. The menu lines and
the "Enter to select" footer are dropped from the status pane, leaving the work
visible and the prompt to the buttons.

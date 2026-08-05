# Implementation Plan

Status: formalized

## Approach

The same seam this repository has now used four times — `MediaDeps`,
`RunShell`, `TurnSummaryDeps`, `scheduledReviewDeps` — applied to the collaborators
the routes reach past their guards:

`sql`, `summarizeOnDisconnect`, `sessionManager.register`, `pushExpect`,
`extractFactsFromTranscript`, `deliverTurnSummary`, `runQuestionExchange`, and
the hook token itself, which is read once at module load from a file on the
host and is otherwise unreachable from a test.

`setMcpDeps(partial)` returns the function that puts them back, so a test
restores exactly what it replaced. Module replacement is not used: replacing
`memory/db.ts` behind this file re-evaluates most of the bot, which is how five
tests in other files broke earlier today.

### What the tests drive

Every route's yes, and every route's own error exit:

- `/health` — the probe the host ingress daemon arms on: connected, and the 503
  when the database will not answer.
- `/api/summarize` — accepted and handed to the summarizer; refused without a
  session id; a malformed body answered rather than thrown.
- `/api/sessions/register` — a session registered under the name it was given
  and under the directory's basename when it was not; refused without a path;
  the manager's failure answered as 500.
- `/api/sessions/expect` — accepted with a numeric id, refused without one, and
  a project path that is not absolute recorded as none.
- `/api/hooks/stop` — 200 before the work starts, and both background jobs
  handed the same paths.
- `/api/hooks/ask-question` — the operator's answers returned, and 204 when the
  exchange returns nothing, which is the contract the terminal depends on.

## Steps

1. `McpDeps`, `setMcpDeps`, and the routes routed through them.
2. `tests/unit/mcp-routes.test.ts`.
3. Re-measure and record.
4. CHANGELOG entry.

## Risks

- **This file is the entry point for every MCP call.** The seam adds an
  indirection and nothing else; the diff should read as a rename of call sites,
  and if it does not, it is wrong.

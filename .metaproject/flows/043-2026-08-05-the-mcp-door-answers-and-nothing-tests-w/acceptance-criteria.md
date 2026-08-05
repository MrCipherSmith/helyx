# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `mcp/server.ts` exposes a `McpDeps` seam and `setMcpDeps`, which returns the function that restores what it replaced.
- AC2: The seam changes no behaviour: every collaborator it carries is the one the file imported, and the diff is call sites only.
- AC3: `/health` is pinned both ways — connected, and 503 with `db: disconnected` when the query fails.
- AC4: `/api/summarize` is pinned three ways: accepted and handed to the summarizer with the id and path it was given; 400 without a session id; a malformed body answered, not thrown.
- AC5: `/api/sessions/register` is pinned four ways: registered with the given name; registered under the directory basename when no name is given; 400 without a project path; 500 when the manager fails.
- AC6: `/api/sessions/expect` is pinned three ways: accepted with a numeric id; 400 without one; a relative project path recorded as none.
- AC7: `/api/hooks/stop` answers 200 before its background work runs, and both fact extraction and the turn summary receive the transcript and project paths.
- AC8: `/api/hooks/ask-question` returns the operator's answers when the exchange produces them and 204 when it produces none.
- AC9: No test in this flow reaches a database, opens a socket, or replaces a module.
- AC10: `mcp/server.ts` line coverage is measured before and after and both figures are recorded.
- AC11: Whole unit suite green, `tsc --noEmit` clean, and the change recorded in `CHANGELOG.md`.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

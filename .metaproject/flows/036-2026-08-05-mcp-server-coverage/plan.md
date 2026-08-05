# Implementation Plan

Status: formalized

## Approach

Move the arrow at `mcp/server.ts:401` into an exported named function and pass
it to `createServer`. The only thing it closes over is `bot` — `transports` is
module-level — so `bot` becomes its third parameter and the move is otherwise
mechanical.

The shape is already in this repository and already tested: `mcp/dashboard-api.ts`
exports `handleDashboardRequest(req, res, url)`, which this very file calls at
line 740, and flow 040 tests it with a recording `ServerResponse` and no socket.

`isLocalRequest` is exported alongside it: it is a pure function that decides
who may reach the MCP endpoint and the hooks, and it deserves to be read
directly rather than through a route.

### What the tests drive

Only the decisions that need no database and start no background work:

- an unknown path;
- `/mcp` from outside the loopback and the Docker bridge;
- `/mcp` without a session id;
- `/api/hooks/stop` from outside, without its fields, and with a transcript
  path that climbs out of the directory it is meant to be in;
- `/api/hooks/ask-question` from a local caller with the wrong shared secret;
- `/api/summarize` with no credentials at all.

### Rejected alternatives

- **A port parameter and real HTTP.** Three lines instead of a move, but every
  test then needs a live database and real auth, and `process.exit(1)` stays in
  the path.
- **Testing the happy paths too.** They write rows and start summarization in
  the background. Without a seam they would reach the real database from a unit
  test.

## Steps

1. Extract `handleMcpRequest`, export it and `isLocalRequest`.
2. `tests/unit/mcp-request.test.ts`.
3. Re-measure and record before and after.
4. CHANGELOG entry.

## Risks

- **It is the busiest entry point in the system.** The mitigation is that the
  change is a move: same body, same order, one parameter added. The diff should
  read as such, and if it does not, it is wrong.

# The MCP door answers, and nothing tests what it answers

Status: formalized
Source: maintainer, 2026-08-05 — "не должно быть мертвых выходов, заглушек"

## Problem

Flow 036 made `mcp/server.ts`'s router reachable and pinned its refusals: who
counts as local, the hook token, the transcript path. It stopped there and said
so, because everything past a refusal writes to Postgres or starts background
work, and a unit test that reached those would reach the real database.

So the door is proven to say no correctly, and nothing at all is proven about
it saying yes. `/health` is what every probe in the system asks — the host
ingress daemon arms on it. `/api/sessions/register` is how a CLI session comes
into existence. `/api/hooks/stop` is what fires fact extraction and the turn
summary at the end of every turn. `/api/hooks/ask-question` is what puts a
question in front of the operator and holds a socket open for ten minutes
waiting for the answer.

Each of those is a path whose failure is silent: a 500 with a JSON body reads
like an answer, and the caller — a hook, a shell script, a daemon — has nobody
to tell.

## Expected Outcome

- The routes' successful answers are pinned: what they return, and what they
  set in motion.
- Their error exits are pinned too, because that is where a dead end would be:
  a 500 that swallows a message, a background failure nobody records.
- No test touches the real database.

## Out of Scope

- The MCP transport itself (`StreamableHTTPServerTransport`, session
  lifecycle). It is an SDK object with a socket; the routes around it are what
  this flow owns.
- The dashboard routes, which are `mcp/dashboard-api.ts` and belong to the
  package in `docs/requirements/coverage-to-sixty-2026-08-05`.

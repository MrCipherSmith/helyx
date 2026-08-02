# Implementation Plan

Status: agreed

## Approach

`utils/supervisor-status.ts` holds the four decisions the broadcast makes,
each returning data rather than a rendered line, so the notify-or-not
question can be asked of state instead of of a string.

- `classifyContainer(status)` → `{ healthy: boolean; reason?: string }`.
  Allowlist, not blacklist: a container is healthy when its status says `Up`
  and does not carry `(unhealthy)` or `(Paused)`. Everything else — including
  `Restarting`, `Created`, `Exited`, `Dead`, and anything docker adds later —
  is not healthy. The point of inverting it is that a state nobody anticipated
  should read as a problem rather than as fine.
- `classifySession({ asmUpdatedMs, pendingMsgs, lastActiveMs, now })` →
  `{ icon, text }`, preserving today's branch order exactly: fresh heartbeat,
  then pending messages, then recently active, then idle.
- `summarizeQueue(pending, stuck)` → the three-way line.
- `hasProblems({ containers, stuckTotal })` — takes the classified containers,
  not the rendered lines.

The supervisor keeps the rendering: it maps each classification to its icon
and builds the same message it builds today. Only the classification and the
notify decision move.

## Steps

1. `utils/supervisor-status.ts` with the four functions.
2. Rewire `sendStatusBroadcast`: classify, then render, then decide.
3. Tests, with the four real `docker ps` status strings as fixtures.
4. `bun run typecheck`, `bun run lint`, `bun test tests/unit/`,
   `keryx health run`.
5. Feed the real `docker ps` output from this host through `classifyContainer`
   and check the answer matches what the containers are actually doing.

## Risks

- **This changes when the operator is notified.** A restarting or unhealthy
  container now makes the broadcast delete-and-resend rather than edit
  silently. That is the intent, but it means a flapping healthcheck will
  notify every five minutes where it previously said nothing. Worth stating
  plainly rather than discovering.
- **The allowlist could paint a healthy container red.** `Up 3 days` and
  `Up 16 hours (healthy)` are the shapes this host actually produces; step 5
  checks them against reality rather than against my reading of the docs.
- **Branch order in `classifySession` is load-bearing** and not obviously so:
  a session with both a fresh heartbeat and queued messages reports "working"
  and says nothing about the queue. Preserved as-is and pinned by a test that
  says why.

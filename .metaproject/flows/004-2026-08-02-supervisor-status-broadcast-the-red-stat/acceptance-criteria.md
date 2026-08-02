# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/supervisor-status.ts` exists and exports `classifyContainer`, `classifySession`, `summarizeQueue` and `hasProblems`.
- AC2: `classifyContainer` reports NOT healthy for `Restarting (1) 5 seconds ago`, `Up 2 minutes (unhealthy)`, `Up 3 days (Paused)`, `Exited (0) 5 minutes ago`, `Created` and `Dead`, and healthy for `Up 3 days`, `Up 16 hours (healthy)` and `Up 2 days`.
- AC3: A test states that classification is an allowlist — an unrecognised status string is reported as not healthy rather than assumed fine.
- AC4: `hasProblems` takes classified containers and a stuck count, not rendered strings, and `scripts/supervisor.ts` contains no emoji-prefix test driving a control decision.
- AC5: `classifySession` preserves today's branch order, with a test asserting that a fresh heartbeat wins over pending messages and explaining that the queue is therefore not mentioned in that state.
- AC6: `summarizeQueue` is tested for all three branches, including the boundary where stuck is 0 but pending is not.
- AC7: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC8: The real `docker ps` output of this host is fed through `classifyContainer` and every answer matches the containers' actual state.
- AC9: `keryx health run` reports coverage strictly above the 17.42% recorded at flow start, with no new gate failure reason beyond the pre-existing coverage warning.
- AC10: The behaviour change is recorded in the PR: a restarting or unhealthy container now triggers a notification where the broadcast previously edited silently.

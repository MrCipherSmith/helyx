# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `decideStartSet` returns only the projects whose `autostart` is true when the current boot id differs from the stored one, whatever the snapshot contains — covered by a unit test that passes a full snapshot and a changed boot id and asserts the result is the autostart set alone.
- AC2: `decideStartSet` returns exactly the snapshot set when the boot id is unchanged and the snapshot is non-empty, including when the snapshot is a strict subset of the autostart set — covered by unit tests.
- AC3: `decideStartSet` never returns an empty set: an unchanged boot id with an empty, missing or undecodable snapshot falls back to the autostart set, and an empty autostart set falls back to the bootstrap project `helyx` — covered by a unit test per branch.
- AC4: `tmuxStop` writes the snapshot of live tmux windows before `tmux kill-session` runs, and the recorded snapshot is the window list read from tmux, not from the `sessions` table — verifiable by reading `cli.ts` and by a test over the extracted snapshot codec.
- AC5: `migrate()` adds `projects.autostart` (default false, seeded true for `helyx` on first creation only), `session_state_events`, and `host_state`, and running it twice against the same database changes nothing the second time.
- AC6: `transitionSession` writes one `session_state_events` row per applied transition, carrying the session, the from/to statuses and a reason, and writes no row when the transition is rejected.
- AC7: `proj_start` with no tmux server running starts only the requested project — the `runCommand("up")` fallback in `scripts/admin-daemon.ts` no longer starts the whole project list.
- AC8: `bun run typecheck`, `bun test tests/unit/` and `bun run dupes` all pass on the finished branch, with the new unit tests included in the run.

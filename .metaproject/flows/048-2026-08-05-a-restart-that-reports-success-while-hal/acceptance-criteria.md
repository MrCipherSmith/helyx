# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `tmuxServerScope()` returns an empty prefix when a tmux server is already reachable, so the first window is created with a plain `tmux new-session`; it returns the `systemd-run --scope --unit=helyx-tmux` prefix only when no server is running, and stops the unit before resetting it. Both branches are covered by unit tests that do not need a real tmux.
- AC2: A failing `tmux new-session`, `new-window` or `send-keys` is propagated: `helyx up` prints a red error for that window, never a green tick, and the process exits non-zero when any window failed to start.
- AC3: `helyx up` and `bounce` verify the outcome before claiming success — a run that ends with zero windows in the `bots` session reports failure regardless of what the individual steps printed.
- AC4: An `admin_commands` row whose session start failed ends in an error status carrying the real stderr, not `status = 'done'` with green ticks in its output.
- AC5: `/now` is present in both `setMyCommands` lists and in a `/menu` group that is visible inside forum topics, and `/menu` can dispatch it.
- AC6: `/restart_docker` restarts the container half (`docker compose up -d` then `docker compose restart`, both outcomes reported separately) and is reachable from all three command levels: `setMyCommands`, the `/menu` System group, and the `/system` panel.
- AC7: `/restart_host` restarts the non-container half (tmux windows, Claude processes, their `channel.ts`, admin-daemon) through the same shared helper the existing `bounce` button uses, and is reachable from the same three levels.
- AC8: The `/system` panel reports tmux ground truth read from the host — whether the `bots` session exists, how many windows it has, and the state of `helyx-tmux.scope` — so a session half that failed to start is distinguishable from one that started and did not register in the database.
- AC9: `bun test` passes, and new unit tests cover the scope decision, the failure propagation, and the zero-window verification.

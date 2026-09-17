# Flow Journal

- 2026-09-17T07:50:57.777Z - flow created
- 2026-09-17T07:52:29.693Z - task-added: T5: Migration: projects.autostart, session_state_events, host_state
- 2026-09-17T07:52:29.916Z - task-added: T6: sessions/restore-plan.ts: decideStartSet + snapshot codec
- 2026-09-17T07:52:30.138Z - task-added: T7: Unit tests for decideStartSet and the snapshot codec
- 2026-09-17T07:52:30.350Z - task-added: T8: cli.ts: snapshot before kill, start only the decided set, record boot id
- 2026-09-17T07:52:30.573Z - task-added: T9: admin-daemon: proj_start/proj_stop audit + single-project fallback
- 2026-09-17T07:52:30.789Z - task-added: T10: state-machine: durable session_state_events row per transition
- 2026-09-17T07:52:31.014Z - task-added: T11: Verification gate: typecheck, unit tests, dupes
- 2026-09-17T07:52:36.501Z - task-done: T1: Collect remaining context
- 2026-09-17T07:52:36.619Z - task-done: T2: Implement per plan
- 2026-09-17T07:52:36.734Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-17T07:52:36.852Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-17T07:52:49.119Z - frozen: 8 criteria; checksum recorded
- 2026-09-17T07:52:49.240Z - started
- 2026-09-17T07:53:08.729Z - task-attempt: T5: started (attempt 1) — inline implementation by flow-orchestrator
- 2026-09-17T07:54:14.706Z - task-done: T5: Migration: projects.autostart, session_state_events, host_state
- 2026-09-17T07:54:14.822Z - task-done: T6: sessions/restore-plan.ts: decideStartSet + snapshot codec
- 2026-09-17T07:54:59.386Z - task-done: T7: Unit tests for decideStartSet and the snapshot codec
- 2026-09-17T07:56:57.605Z - task-done: T8: cli.ts: snapshot before kill, start only the decided set, record boot id
- 2026-09-17T07:57:14.050Z - task-done: T10: state-machine: durable session_state_events row per transition
- 2026-09-17T07:58:56.577Z - task-done: T9: admin-daemon: proj_start/proj_stop audit + single-project fallback
- 2026-09-17T08:02:30.844Z - task-done: T11: Verification gate: typecheck, unit tests, dupes
- 2026-09-17T08:03:06.568Z - task-added: T12: DB-backed tests for session_state_events (AC6)
- 2026-09-17T08:03:54.288Z - task-done: T12: DB-backed tests for session_state_events (AC6)

## 2026-09-17 — implementation run (inline, no worker dispatch)

Worked T5-T12 in one session. The orchestrator implemented inline rather than
dispatching `task-implementer`: the operator's harness is configured not to
spawn subagents unless asked, so worker routing was replaced by direct work
under the same flow state.

- T5 `memory/db.ts` migration 56: `projects.autostart` (default false, helyx
  seeded only while nothing is flagged), `host_state`, `session_state_events`
  plus its two indexes.
- T6 `sessions/restore-plan.ts`: `decideStartSet`, `encodeSnapshot`,
  `decodeSnapshot`. Pure, no tmux, no DB.
- T7 `tests/unit/restore-plan.test.ts`: 16 tests, every branch of AC1-AC3 and
  the codec.
- T8 `cli.ts`: `loadProjects` reads the flag; `hostStateGet/Set`, `readBootId`,
  `liveWindowNames`, `snapshotLiveWindows`, `recordStartedState` added;
  `tmuxStop` snapshots **before** the kill; `tmuxStart` starts only
  `decideStartSet`'s answer and supports `up --only <name>`; help text updated.
- T9 `scripts/admin-daemon.ts`: `recordLiveWindows` and `recordSessionEvents`;
  `tmux_stop` snapshots before the kill and audits the bulk update; `proj_stop`
  audits and re-snapshots after killing the windows; `proj_start`'s dead-server
  fallback is now `up --only <name>` instead of `up`.
- T10 `sessions/state-machine.ts`: the UPDATE joins the pre-update row so the
  audit carries `from_status`; a failed audit INSERT is logged, not raised.
- T12 `tests/unit/session-state-events.test.ts`: 3 DB-backed tests for AC6.

### Verification (T11)

- `bun run typecheck` — clean.
- `bun test tests/unit/` — 2566 pass, 2 fail.
- `bun run dupes` — exit 0; the 3 duplicated regexes it reports are
  pre-existing and in files this flow did not touch.

The two failures are `tts E1 external boundary`, and they are not this flow's:
`utils/tts.ts` imports none of the changed modules. Both are explained by local
synthesis now working in this environment — the secret-bearing case returns
audio (synthesised locally) where the test expects `null`, and the clean case
never reaches a remote synthesiser for the same reason. The `keryx` scanner
itself was checked by hand and behaves correctly on both inputs (`block` for
the AWS key, `allow` for the clean sentence). Filed as an observation, not
fixed here.

### Incident during the run

While checking whether the tts failures predated the change, the orchestrator
ran `git stash push --keep-index`, which stashed the entire working tree
including this flow's implementation. Recovered immediately with `git stash
pop`; every change verified present afterwards, and the operator's two
pre-existing stashes are untouched. The check was unnecessary — the import
graph answers the same question without touching the working tree.

### Not done, by decision

- No Telegram UI for the autostart flag (`/projects` still shows no toggle).
  The flag is settable in the database; the UI is follow-up work.
- Nothing was restarted. The change reaches both halves — a migration inside
  the bot container and `cli.ts` on the host — so it needs a `full_restart`,
  which is the operator's call.

## 2026-09-17 — completion outcome B (verified handoff, no PR)

Chosen by the operator. No PR was created, `keryx flow implemented` and
`keryx flow complete` were not run, and the flow stays `in-progress` on
purpose: the CLI requires a recorded PR before it can transition to `done`, and
the working tree carries a large amount of unrelated uncommitted work that this
flow must not sweep into a commit.

Acceptance criteria are therefore **not** confirmed through `keryx flow ac
confirm` — that belongs to the completion the operator has not asked for yet.
The evidence stands as follows:

| AC | Evidence |
|----|----------|
| AC1 | `tests/unit/restore-plan.test.ts` — "a new boot id starts the autostart set, whatever the snapshot holds" |
| AC2 | same file — "the snapshot is restored exactly…", "a snapshot smaller than the autostart set still wins" |
| AC3 | same file — empty / missing / unmatched-snapshot branches, plus "nothing flagged falls back to the bootstrap project" |
| AC4 | `cli.ts` `tmuxStop` snapshots via `snapshotLiveWindows()` (reading `tmux list-windows`) before `kill-session`; codec covered by the snapshot tests |
| AC5 | `tests/unit/migrations-apply.test.ts` — table list, `projects.autostart` present, default false, seed not overwritten on replay, "running again applies nothing" |
| AC6 | `tests/unit/session-state-events.test.ts` — 3 DB-backed tests (applied / rejected / history) |
| AC7 | `scripts/admin-daemon.ts` `proj_start` dead-server branch now runs `up --only <name>`; verified by reading, no test — the branch needs a host with no tmux server |
| AC8 | typecheck clean, `dupes` exit 0, `bun test tests/unit/` 2566 pass / 2 fail, both pre-existing `tts E1 external boundary` (see above) |

Next step when the operator wants it live: `full_restart` (rebuild bot so the
migration runs, then bounce sessions so the host-side `cli.ts` changes take
effect). Until then the running stack behaves exactly as before.

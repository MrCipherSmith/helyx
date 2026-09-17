# Decisions

- F-001: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — decideRecordAfterStart in sessions/restore-plan.ts, covered by tests/unit/restore-plan.test.ts 'a cold start that brought nothing up clears the snapshot and does not claim the boot' (valid_followup, post_flow_feedback).
- F-002: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — try/catch around the host_state upsert in recordLiveWindows, with the deploy-order reason recorded in the comment (valid_followup, post_flow_feedback).
- F-003: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — recordLiveWindows({ whenNoSession: 'empty' }) in the proj_stop branch (valid_followup, post_flow_feedback).
- F-004: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — the daemon reads projects.name for the path, and --only matches name or path in cli.ts (valid_followup, post_flow_feedback).
- F-005: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — decideRecordAfterStart returns recordBootId: false for --only, covered by tests/unit/restore-plan.test.ts (valid_followup, post_flow_feedback).
- F-006: dismissed-out-of-scope — decided-by: operator (aleks.zeitler@gmail.com), 2026-09-17, asked explicitly and answered 'close as out of scope': the daemon never passes -s (the 2026-09-01 incident), and the limit is documented in help() by commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118). Pane-level restore is a separate change. (valid_followup, post_flow_feedback).
- F-007: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — WITH prev AS (SELECT ... FOR UPDATE) in transitionSession and in both admin-daemon mass updates (valid_followup, post_flow_feedback).
- F-008: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — snapshotLiveWindows returns { windows, stored } and tmuxStop warns when stored is false (valid_followup, post_flow_feedback).
- F-009: acted-on — commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) — the test deletes schema_versions for migration 56 and asserts runMigrations re-applies exactly it (valid_followup, post_flow_feedback).

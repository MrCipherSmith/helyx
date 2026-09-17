# Managed Review Report — flow 067

One independent reviewer ran through the repository's own pipeline
(`scripts/review.ts`, provider-backed, no subagents): Claude (claude-opus-5).
Codex exited 1, DeepSeek timed out, GLM was out of balance — all three are
recorded as unavailable rather than as clean.

Target: 6a325db, the commit merged as PR #117
(https://github.com/MrCipherSmith/helyx/pull/117).

Verdict: REQUEST_CHANGES. 0 blockers, 2 majors, 4 minors, 3 infos. Eight of the
nine were fixed in 57f8c1f (PR #118); the ninth — split-pane restore — is
recorded as out of scope and documented in `help()` instead.

The reviewer confirmed, by name, the four things it was asked to attack that
turned out sound: the cold-vs-restart decision in `sessions/restore-plan.ts`,
the snapshot-before-kill ordering in `tmuxStop`, the psql string building in the
`host_state` helpers (argv, not a shell; `''` escaping with
standard_conforming_strings), and the audit write's inability to break a
committed transition under today's callers.

```keryx:findings
[
  {
    "id": "F-001",
    "severity": "major",
    "file": "cli.ts",
    "symbol": "recordStartedState",
    "problem": "A cold start that brought nothing up recorded the new boot id while leaving the previous boot's snapshot in place.",
    "impact": "The operator's next `up` counted as a restart and restored the entire pre-reboot fleet \u2014 the exact outcome flow 067 exists to prevent.",
    "suggested_fix": "Record the boot id only when a session actually exists; on a cold start with nothing live, clear the snapshot.",
    "evidence": "Reviewer traced stack_up -> up -> startWindow failure -> recordStartedState writing HOST_STATE_BOOT_ID unconditionally while snapshotLiveWindows returned null.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 decideRecordAfterStart in sessions/restore-plan.ts, covered by tests/unit/restore-plan.test.ts 'a cold start that brought nothing up clears the snapshot and does not claim the boot'"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "cli.ts:1536 \u2014 the only write of HOST_STATE_BOOT_ID (recordStartedState)",
        "cli.ts:1531 \u2014 the snapshot write in the same function, the half that was skipped when tmux had no session",
        "cli.ts:1510 \u2014 the other snapshot writer (snapshotLiveWindows, used by tmuxStop), which does not write the boot id",
        "scripts/admin-daemon.ts:350 \u2014 the daemon's snapshot write, which also never writes the boot id"
      ],
      "enumeration_method": "`keryx ctx rg 'HOST_STATE_BOOT_ID|HOST_STATE_SNAPSHOT|host_state' --glob '!node_modules' --glob '!.metaproject/**'` over the whole repository: four write sites in two files, plus the constants in sessions/restore-plan.ts, the reads in cli.ts:1733-1734 and the DDL in memory/db.ts. Exhaustive because every access goes through the two exported key constants."
    }
  },
  {
    "id": "F-002",
    "severity": "major",
    "file": "scripts/admin-daemon.ts",
    "symbol": "recordLiveWindows",
    "problem": "The daemon's snapshot write was not guarded; a DB error propagated into the command result.",
    "impact": "tmux_stop threw before its kill-session and never stopped anything; a proj_start that had already started the project was reported as failed, inviting a second press whose kill-window loop takes the fresh session down. Most likely trigger is deploy order: migration 56 runs inside the bot container while the daemon runs on the host, so a daemon restarted first sees no host_state table.",
    "suggested_fix": "Wrap the write in try/catch and log, the way recordSessionEvents does.",
    "evidence": "Reviewer followed the throw to the outer catch in processCommand which sets result.ok = false.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 try/catch around the host_state upsert in recordLiveWindows, with the deploy-order reason recorded in the comment"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "scripts/admin-daemon.ts:349-353 \u2014 the unguarded host_state upsert (the defect)",
        "scripts/admin-daemon.ts recordSessionEvents \u2014 the sibling write, already guarded, which is the shape the fix copies",
        "cli.ts:1459-1465 hostStateSet \u2014 the other process's writer, guarded by dbQuery returning ok instead of throwing"
      ],
      "enumeration_method": "Same repository-wide search for host_state writers, intersected with the two processes that own a database handle: the daemon (`sql`, throws) and cli.ts (`dbQuery`, returns ok). Every daemon-side write of flow 067 data is listed; the sibling and the cross-process counterpart are included even though they were already correct."
    }
  },
  {
    "id": "F-003",
    "severity": "minor",
    "file": "scripts/admin-daemon.ts",
    "symbol": "proj_stop",
    "problem": "Stopping the last window destroys the bots session, so list-windows failed, recordLiveWindows returned null, and the stopped project stayed in the snapshot.",
    "impact": "The next tmux_start or stack_up in the same boot restored the project the operator had just stopped \u2014 the opposite of what the code comment claimed.",
    "suggested_fix": "In proj_stop treat 'no session' as an empty snapshot and write it; this caller killed the windows itself.",
    "evidence": "Reviewer walked the single-project case: snapshot ['keryx'], proj_stop keryx, session gone, snapshot unchanged.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 recordLiveWindows({ whenNoSession: 'empty' }) in the proj_stop branch"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "severity": "minor",
    "file": "scripts/admin-daemon.ts",
    "symbol": "proj_start",
    "problem": "proj_start derived the window name from the directory basename while tmuxStart names windows and matches the restore snapshot by projects.name.",
    "impact": "A project added with `helyx add . --name <other>` failed the new --only path outright (a regression against the old `up`), and any window it did create could never be matched by the restore.",
    "suggested_fix": "Send project_id or the stored name, or have --only match on path.",
    "evidence": "Reviewer compared admin-daemon's `path.split('/').pop()` with tmuxStart's `p.name === only`.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 the daemon reads projects.name for the path, and --only matches name or path in cli.ts"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high"
  },
  {
    "id": "F-005",
    "severity": "minor",
    "file": "cli.ts",
    "symbol": "tmuxStart --only",
    "problem": "The --only path skipped decideStartSet but still recorded the boot id.",
    "impact": "A single-project start right after a reboot consumed the cold start, so every later stack_up counted as a restart of that one project and the autostart set \u2014 helyx included \u2014 never came up.",
    "suggested_fix": "Skip the boot id on the --only path, or start the autostart set alongside it.",
    "evidence": "Reviewer traced proj_start -> up --only keryx -> recordStartedState on a fresh boot.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 decideRecordAfterStart returns recordBootId: false for --only, covered by tests/unit/restore-plan.test.ts"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high"
  },
  {
    "id": "F-006",
    "severity": "minor",
    "file": "cli.ts",
    "symbol": "tmuxStart -s",
    "problem": "With split panes every project is a pane of one window named after the first project, so the snapshot holds one name.",
    "impact": "A bounce started with `up -s` restores one project where it previously restarted all of them.",
    "suggested_fix": "Record panes, or document that restore does not work with -s.",
    "evidence": "Reviewer read startWindow's usePanes branch against snapshotLiveWindows.",
    "disposition": {
      "state": "dismissed-out-of-scope",
      "evidence": "decided-by: operator (aleks.zeitler@gmail.com), 2026-09-17, asked explicitly and answered 'close as out of scope': the daemon never passes -s (the 2026-09-01 incident), and the limit is documented in help() by commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118). Pane-level restore is a separate change."
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high"
  },
  {
    "id": "F-007",
    "severity": "info",
    "file": "sessions/state-machine.ts",
    "symbol": "transitionSession",
    "problem": "`UPDATE ... FROM sessions prev` re-checks the target row against its new version under a concurrent update while the joined copy holds the statement-start version.",
    "impact": "The audit row can name a status the row no longer had. The status change itself stays correct.",
    "suggested_fix": "Lock the row first with a CTE using FOR UPDATE.",
    "evidence": "Reviewer cited Postgres re-check semantics for concurrent UPDATE.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 WITH prev AS (SELECT ... FOR UPDATE) in transitionSession and in both admin-daemon mass updates"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high"
  },
  {
    "id": "F-008",
    "severity": "info",
    "file": "cli.ts",
    "symbol": "tmuxStop",
    "problem": "tmuxStop printed 'recorded for restore' without checking whether hostStateSet succeeded.",
    "impact": "A failed write left the restart using an older snapshot while the log claimed the new one was recorded.",
    "suggested_fix": "Return the write result and say so when it failed.",
    "evidence": "Reviewer noted the ignored return value of hostStateSet.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 snapshotLiveWindows returns { windows, stored } and tmuxStop warns when stored is false"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high"
  },
  {
    "id": "F-009",
    "severity": "info",
    "file": "tests/unit/migrations-apply.test.ts",
    "symbol": "autostart seed test",
    "problem": "The seed test re-ran a copy of migration 56's UPDATE instead of the migration.",
    "impact": "The migration and its test could drift apart without the test failing.",
    "suggested_fix": "Delete the version row and re-run runMigrations.",
    "evidence": "Reviewer compared the test body with migration 56.",
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 57f8c1fe93804b41d316275753887c44d7ff23be (PR #118) \u2014 the test deletes schema_versions for migration 56 and asserts runMigrations re-applies exactly it"
    },
    "reviewer": "claude-opus-5 (scripts/review.ts reviewer pipeline)",
    "confidence": "high"
  }
]
```

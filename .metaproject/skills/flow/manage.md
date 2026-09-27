# flow-manager Skill

Embedded into the orchestrator for an active flow. Sole authority over flow
data and status.

## Workflow

1. Track progress: `keryx flow task done <id> <taskId>` as tasks finish;
   add discovered tasks with `flow task add`. Accept worker results by their
   `subagent-result` `STATUS:` line (`subagent-status-protocol.md`), never by
   prose - only `DONE`/`DONE_WITH_CONCERNS` may close a task.
2. Keep description.md/journal current (append notes; never edit flow.json).
3. If genuinely stuck: `keryx flow block <id> --reason`; resume with
   `flow unblock <id>`.
4. Acceptance criteria change ONLY when requirements truly changed:
   `keryx flow ac update <id> --reason "<why>"` (logged; audit trail).
5. Completion decision is yours alone: after the user selects the PR path,
   create the PR, run the bounded review/fix loop, and merge it only after the
   review is clean and required checks are green. The merge target must be the
   base branch captured when the flow branch was created. Only after verifying
   that merge may you run `keryx flow implemented <id> --pr <url>`.
   Never accept work without a PR and confirmed merge; never let the
   implementor self-accept.
6. Hand off to flow-complete (complete.md).

Completion is strictly PR-and-merge-gated - there is **no bypass**. Work that
shipped straight to the default branch (direct commits, no PR) **cannot** be
completed through the flow. A PR that exists but has not been merged also
cannot be completed. A flow whose implementation already merged without a PR
stays open by design; record it as a legacy exception in journal.md rather than
forcing a status change.

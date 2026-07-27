# Job Orchestrator — Quick Reference Checklist

> **Purpose:** Condensed execution checklist for the orchestrator agent.
> This file is a quick reference — the full specification is in `SKILL.md`.
> The orchestrator is NOT a sub-agent; it IS the primary agent executing this checklist.
> When in doubt, refer to `SKILL.md` for complete details.

## Data Flow

```
[User] → "implement issue #4141" / "analyze issue" / other request
     ↓
[Orchestrator] → loads SKILL.md, follows this checklist
     ↓
Phase 0: Context collection, intent determination, plan building
     ↓
Phase 1: [job-documenter sub-agent] → initialize .metaproject/jobs/<job-name>/ + README + plan
     ↓
Phase 2: Execute plan dynamically:
     ↓
     ├─ [issue-analyzer sub-agent] → JSON analysis result
     ├─ git worktree add → feature branch (NEVER git checkout -b)
     ├─ FOR EACH wave → [wave-executor sub-agent] → compact WAVE_DONE summary
     ├─ Load review skills → findings
     ├─ IF findings → [task-implementer sub-agent (fix)] → re-review (max 2x)
     ├─ npm run lint && type-check && test
     └─ [job-documenter] → document each step result
     ↓
Phase 3: [job-documenter] → finalize → final report
     ↓
(Optional) gh pr create --draft
```

## Phase 0: Context Collection (Guard Clause)

Before starting, determine intent and collect context:

1. **Determine intent** from user request:
   - "Implement issue" → `implement` (full cycle)
   - "Analyze issue" / "Study issue" → `analyze` (analysis first, then offer implementation)
   - "Review" → `review` (review only)
   - Other → `custom` (dynamic plan)

2. **Project directory** → ALWAYS ask, never assume:
   ```
   Which project directory should I use?
   ○ Type the full absolute path to your project
   ```

3. **Base branch** → ask to confirm (no default).

4. **Job name** → auto-generate + confirm:
   - `issue-<N>--<slug>` for implement
   - `analysis--issue-<N>` for analyze
   - `review--<slug>` for review
   - `task--<slug>` for custom

5. **Additional questions** by intent:
   - `implement`: Create PR? (default: yes)
   - `analyze`: nothing (ask about implementation after analysis)

6. **Show summary and ask for confirmation** before starting.

## Phase 1: Initialize Documentation

Dispatch `job-documenter` sub-agent with `ACTION: init`.

Write initial `state.json` to `.metaproject/jobs/<job-name>/state.json` after job docs are initialized.

Verify `DOCUMENTER_RESULT.status == "success"`.

## Phase 2: Execute Plan

Execute plan steps sequentially. After each step:
1. Collect result
2. Send to `job-documenter` (ACTION: add-document)
3. Update README (ACTION: update-readme)
4. Update `state.json` with step completion
5. Mark step as completed

### Step: ANALYZE

Read `skills/issue-analyzer/orchestrator-prompt.md`, fill in parameters:

```
ISSUE_URL: <url>   (or ISSUE_REPO + ISSUE_NUMBER)
CODEBASE_PATHS: [{path, role, branch}]
MAX_TASKS: 7 (default)
SEARCH_DEPTH: focused (default)
```

Launch Task(issue-analyzer). Parse JSON result — extract tasks and dependency_order.

For `analyze` intent: show result, ask "Implement? (yes/no)".
- yes → extend plan: prepare → implement → review → fix → checks → report → pr
- no → Phase 3

### Step: PREPARE — Create Feature Branch

> **CRITICAL**: Use ONLY `git worktree add`. NEVER `git checkout -b`.

```bash
git -C <project_dir> fetch origin <base_branch>
git -C <project_dir> worktree add ../<branch-slug> -b feature/<branch-slug> origin/<base_branch>
npm install --prefix <worktree_path>
```

All subsequent operations ONLY in worktree directory.

### Step: IMPLEMENT — Wave Isolation

```
WAVES = topological_sort_into_waves(dependency_order, task_dependencies)

FOR wave_index, wave_tasks in enumerate(WAVES):
  1. Dispatch single Agent("wave-executor") with all tasks in this wave
     (see skills/job-orchestrator/SKILL.md step 2.4.1 for full prompt template)
  2. Receive compact WAVE_RESULT:
       STATUS: WAVE_DONE | WAVE_PARTIAL | WAVE_FAILED
       Commits: [hash msg, ...]
       Tests: N passed, M failed
       Tasks: task-1 ✅, task-2 ✅
  3. Decision:
       WAVE_DONE    → continue to next wave
       WAVE_PARTIAL → log concerns (read result files if needed), continue
       WAVE_FAILED  → STOP, read result files for failed tasks, ask user

Do NOT dispatch task-implementers directly — always via wave-executor.
Context budget rule: orchestrator only accumulates compact wave summaries,
never raw task-implementer output.
```

Document result in job-documenter.

### Step: REVIEW — Run Reviewers

```
REVIEWERS = ["code-ai-review", "code-boss-review", "code-style-review"]
IF *.store.ts modified: add "code-mobx-store-review"

FOR reviewer in REVIEWERS:
  Load skill → execute → collect findings as JSON
```

Document result.

### Step: FIX — Review-Fix Loop (max 2 iterations)

If CRITICAL or WARNING findings exist:
1. Group by file
2. Launch task-implementer (task_type: "fix") with review findings JSON
3. Re-run reviewers
4. Recount findings

### Step: CHECKS — Final Verification

```bash
npm run lint
npm run type-check
npm test
```

### Step: REPORT — Generate Final Report

Markdown report per template in SKILL.md (section 2.9).

### Step: PR — Propose Draft PR (optional)

Dispatch `pr-issue-documenter` to generate PR description.
Present to user, ask confirmation, then:
```bash
gh pr create --title "<title>" --body "..." --base <base> --head <head> --draft
```

## Phase 3: Completion

1. Dispatch `job-documenter` with `ACTION: finalize`
2. Update `state.json` with `phase: "COMPLETION"`
3. Tell user what was accomplished + documentation path + PR URL (if created)

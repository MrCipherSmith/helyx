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
Phase 0: keryx job list --json → resume or start; collect context; confirm
     ↓
Phase 1: keryx job init --name <slug> --intent <intent> --project <path>
     ↓
Phase 2: Execute plan, bracketing every step with keryx job step:
     ↓
     ├─ [issue-analyzer sub-agent] → JSON analysis result
     ├─ git worktree add → feature branch (NEVER git checkout -b)
     ├─ FOR EACH wave → [tests-creator × tasks] then [task-implementer × tasks]
     ├─ [code-verifier sub-agent] → quality gate
     ├─ keryx review start → [review-orchestrator sub-agent] → keryx review ingest
     ├─ IF blocker/major → [task-implementer (fix)] → next managed round (max 3)
     ├─ keryx review complete --finding … --disposition … --evidence …
     └─ keryx job document → each step's artifact recorded in the package
     ↓
Phase 3: keryx job complete <job-name> → final report
     ↓
(Optional) gh pr create --draft
```

Every sub-agent dispatch uses `subagent_type: "general-purpose"`.

## Phase 0: Context Collection (Guard Clause)

0. **Check for an unfinished job first:**
   ```bash
   keryx job list --json          # phase != COMPLETION means unfinished
   keryx job status <name> --json # next_step is where to resume
   ```

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

3. **Base branch** → auto-detect, present, ask to confirm. No hardcoded default.

4. **Job name** → auto-generate + confirm. Must match `^[a-z0-9-]+$`:
   - `issue-<N>--<slug>` for implement
   - `analysis--issue-<N>` for analyze
   - `review--<slug>` for review
   - `task--<slug>` for custom

5. **Additional questions** by intent:
   - `implement`: Create PR? (default: yes)
   - `analyze`: nothing (ask about implementation after analysis)

6. **Show summary and ask for confirmation** before starting. This operator gate is
   not governed by `skip_confirmation`, which covers sub-agent dispatch only.

## Phase 1: Create the Job Package

```bash
keryx job init --name <job-name> --intent implement|analyze|review|custom --project <project_dir>
keryx job status <job-name>     # confirm the plan, phase and first open step
```

`keryx job` is the only writer of `state.json`, and it validates every write against
the registered contract `job-orchestrator-state`. Never hand-write the file.

## Phase 2: Execute Plan

Execute plan steps in order. For each step:

```bash
keryx job step <job-name> <step-id> --status in-progress    # counts a retry on re-entry
# … run the step …
keryx job document <job-name> --type <analysis|implementation-report|review|verification-report> --file <path>
keryx job status <job-name>                                  # the job index
keryx job step <job-name> <step-id> --status completed
```

A conditional step whose trigger did not fire is closed too:
`keryx job step <job-name> <step-id> --status skipped --reason "<why>"`.

### Step: ANALYZE

Read `skills/gdskills/orchestration/issue-analyzer/orchestrator-prompt.md`, fill in parameters:

```
ISSUE_URL: <url>   (or ISSUE_REPO + ISSUE_NUMBER)
CODEBASE_PATHS: [{path, role, branch}]
MAX_TASKS: 7 (default)
SEARCH_DEPTH: focused (default)
```

Launch Task(issue-analyzer). Parse JSON result — extract tasks and dependency_order.

For `analyze` intent: show result, ask "Implement? (yes/no)".
- yes → create a second package: `keryx job init --name <name>-impl --intent implement …`
- no → Phase 3

### Step: PREPARE — Create Feature Branch

> **CRITICAL**: Use ONLY `git worktree add`. NEVER `git checkout -b`.

```bash
git -C <project_dir> fetch origin <base_branch>
git -C <project_dir> worktree add ../<branch-slug> -b feature/<branch-slug> origin/<base_branch>
# then install with the DETECTED package manager — never hardcode npm
```

All subsequent operations ONLY in the worktree directory.

### Step: TESTS-CREATOR + IMPLEMENT — Waves

```
WAVES = dependency_order from ANALYSIS_RESULT (already topologically sorted)

FOR wave_index, wave_tasks in enumerate(WAVES):
  1. Dispatch one tests-creator per task, in a SINGLE turn (parallel). Wait for all.
     Load skill: skills/gdskills/quality/tests-creator/SKILL.md
  2. Parallel safety check: tasks sharing a target_file run sequentially.
  3. Dispatch one task-implementer per task, in a SINGLE turn (parallel). Wait for all.
     Load skill: skills/gdskills/orchestration/task-implementer/SKILL.md
  4. Read each STATUS line:
       all DONE               → next wave
       any DONE_WITH_CONCERNS → record concerns, continue
       any BLOCKED            → STOP, read the result file, resolve or ask the user

There is no wave-executor agent. Instruct every dispatched agent to write full
detail to <JOBS_ROOT>/<job-name>/results/<task_id>.json and return only a compact
summary — context grows with what agents RETURN.
```

Record with `keryx job document --type implementation-report`.

### Step: VERIFY — Quality Gate

Dispatch `code-verifier` (`skills/gdskills/orchestration/code-verifier/SKILL.md`) with
`codebase_path`, `base_branch`, `scope: changed`. Record with
`keryx job document --type verification-report`.

### Step: REVIEW — One Managed Round

```bash
keryx review budget  --spent <usd> --outstanding <subagents in flight>   # STOP on non-zero exit
keryx review start   --target branch --ref <feature-branch> --head "$(git rev-parse HEAD)"
keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha> --round <n> --out <file>
keryx review scope        --ref "$BASE_SHA" --json > scope.json
keryx review blast-radius --ref "$BASE_SHA" --json > blast-radius.json    # KEEP BOTH
keryx review stack --json                                                # which reviewers apply
keryx review tier  --scope <scope> --diff-lines <n> --json                # model per dispatch
# dispatch review-orchestrator (skills/gdskills/review/review-orchestrator/SKILL.md);
# it runs review-verifier in Wave C and emits the ```json keryx:findings``` block
keryx review ingest --report <report.md> --ref <feature-branch> --head <sha> \
  --scope scope.json --blast-radius blast-radius.json \
  --verifications <file> --refuted <file> --outstanding <n>
```

`--blast-radius` is required on any round that dispatched `review-regression`; an
ingest carrying a scope-B finding without it is refused. Severities are
`blocker|major|minor|info`. Record with `keryx job document --type review`.

### Step: FIX — Review-Fix Loop (max 3 iterations)

If `blocker` or `major` findings exist:
1. Group by file
2. Launch task-implementer (`task_type: "fix"`) with the findings
3. Run the sanity check — verify commits were made
4. Run the NEXT managed round (the whole REVIEW sequence above, `is_fix_round: true`)
5. Disposition every finding of the previous round:
   ```bash
   keryx review complete <review-id> --finding F-001 --disposition acted-on --evidence "<commit>"
   ```
6. STUCK CHECK — break on a repeated finding identity or an identical report, even
   with iterations left. `keryx review loop --flow <id>` detects it from the record.

After the LAST round only:
```bash
keryx review comments reply --repo <owner/repo> --pr <n> --outcomes <file> --review <review-id> --sha <sha> --final
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

1. Close every remaining step: `keryx job step <job-name> <step-id> --status completed|skipped --reason "<why>"`
2. `keryx job complete <job-name>` — refused while any step is open or failed, and it names them
3. Tell the user what was accomplished, the package path, and the PR URL (if created)

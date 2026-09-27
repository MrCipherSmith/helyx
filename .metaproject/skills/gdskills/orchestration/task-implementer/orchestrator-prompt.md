# Task Implementer — Orchestrator Prompt

> **Purpose:** Template `job-orchestrator` fills in to dispatch `task-implementer` as a sub-agent.
> The orchestrator fills in the placeholders below and sends the result as a Task prompt.
> The task-implementer executes SKILL.md autonomously, writes the full JSON result to a file, records it with `keryx job document`, and returns a compact STATUS response.

## Data Flow

```
[job-orchestrator] → extracts tasks → fills template → Task(task-implementer) × N (parallel)
                                                                  ↓
[task-implementer] → executes SKILL.md → writes JSON to .metaproject/jobs/<job-name>/results/<task_id>.json
                                        → keryx job document <job-name> --type implementation-report
                                                                  ↓
[Result]           → compact STATUS: DONE response (no inline JSON)
                                                                  ↓
[job-orchestrator] → collects STATUS responses; reads a result file only for
                     DONE_WITH_CONCERNS or BLOCKED
```

**There is no `wave-executor` agent.** The orchestrator dispatches every task in
a wave itself, in one turn, and collects the STATUS lines itself — the same
statement `job-orchestrator/SKILL.md` makes. This document described a
`wave-executor` as real in four places while the agent it named existed in no
catalogue and no dispatcher; `src/job/plans.ts` names `task-implementer` as the
`implement` and `fix` step agents, with nothing in between.

## Step 1: Extract Task Parameters

From the issue-analyzer JSON output, extract one task object:

```
TASK:
  task_id              → from tasks[i].task_id
  task_name            → from tasks[i].task_name
  task_type            → from tasks[i].task_type
  complexity           → from tasks[i].complexity
  dependencies         → from tasks[i].dependencies (dispatch in dependency_order)
  description          → from tasks[i].description
  target_files         → from tasks[i].target_files
  acceptance_criteria  → from tasks[i].acceptance_criteria
  context              → from tasks[i].context
  existing_tests       → from tasks[i].existing_tests
  existing_stories     → from tasks[i].existing_stories
  module_patterns      → from tasks[i].module_patterns

WORKSPACE:
  codebase_path        → absolute path to project repo (worktree path)
  branch               → feature branch name (already checked out in worktree)
  issue_number         → Optional real GitHub issue number; omit for description-based tasks
  issue_title          → GitHub issue title

JOB_CONTEXT (optional):
  job_name             → job folder name
  context_path         → <JOBS_ROOT>/<job-name>/ai/context.md
```

## Step 2: Validate

Write the assembled `{ task, workspace, automation }` object to a file and run:

```bash
keryx skills contracts validate <request.json> --schema task-implementer-input
```

Non-zero exit means the request is malformed — the command names the field and
the rule. Do not dispatch a request that does not validate. The schema is
`input-contract.schema.json` in this folder, registered in
`src/gdskills/contracts.ts`; it is what refuses an empty `target_files`, a
`task_type` outside the enum, a `task_id` that is not `task-<n>`, a missing
`codebase_path`/`branch`, `skip_confirmation` other than `true`,
`max_self_fix_attempts` above 3, and any undeclared field.

One check the schema cannot make, because it is a fact about the machine:

```bash
test -d "<CODEBASE_PATH>"   # otherwise ABORT: "Codebase path not found"
```

## Step 3: Build Sub-Agent Prompt (regular task)

```
You are running the task-implementer skill in AUTONOMOUS MODE.
DO NOT ask the user any questions. Execute the full workflow end-to-end.

Load the skill: task-implementer (from skills/gdskills/orchestration/task-implementer/SKILL.md)

═══════════════════════════════════════════════
  TASK
═══════════════════════════════════════════════

{
  "task_id": "<TASK_ID>",
  "task_name": "<TASK_NAME>",
  "task_type": "<TASK_TYPE>",
  "complexity": "<COMPLEXITY>",
  "dependencies": [<DEPENDENCY_LIST>],
  "description": "<DESCRIPTION>",
  "target_files": [<TARGET_FILES_LIST>],
  "acceptance_criteria": [<ACCEPTANCE_CRITERIA_LIST>],
  "context": "<CONTEXT>",
  "existing_tests": [<EXISTING_TESTS_LIST>],
  "existing_stories": [<EXISTING_STORIES_LIST>],
  "module_patterns": "<MODULE_PATTERNS>"
}

═══════════════════════════════════════════════
  WORKSPACE
═══════════════════════════════════════════════

CODEBASE_PATH: <CODEBASE_PATH>
BRANCH:        <BRANCH>
ISSUE_NUMBER:  <ISSUE_NUMBER>
ISSUE_TITLE:   <ISSUE_TITLE>

<!-- If job context available: -->
JOB_NAME:     <JOB_NAME>
CONTEXT_PATH: <JOBS_ROOT>/<JOB_NAME>/ai/context.md

═══════════════════════════════════════════════
  AUTOMATION SETTINGS
═══════════════════════════════════════════════

1. CONFIRMATION: SKIP. Proceed immediately.
2. AUTO COMMIT: true
3. VERIFY LINT: true
4. VERIFY TYPES: true
5. VERIFY TESTS: true
6. MAX SELF-FIX ATTEMPTS: 3

═══════════════════════════════════════════════
  EXECUTION INSTRUCTIONS
═══════════════════════════════════════════════

1. Load task-implementer SKILL.md
2. Execute all 6 phases: RECEIVE → RESEARCH → PLAN → IMPLEMENT → VERIFY → REPORT
3. Phase 6: Write full JSON result to <JOBS_ROOT>/<JOB_NAME>/results/<task_id>.json,
   then validate and record it:
     keryx skills contracts validate <that file> --schema task-implementer-output
     keryx job document <JOB_NAME> --type implementation-report --file <that file>
   Both refuse rather than warn; `job document` refuses outright if the file was
   never written.
4. Return a compact STATUS response as your FINAL MESSAGE — NO inline JSON:

   STATUS: DONE
   ## Completed
   - <what was done>
   ## Files changed
   - <file> — <change>
   ## Verification
   - lint: pass / type-check: pass / tests: N passed
   Result file: <JOBS_ROOT>/<JOB_NAME>/results/<task_id>.json

DO NOT ask questions. DO NOT stop for user input. DO NOT include the JSON block in your response. Run to completion.
```

## Step 4: Build Sub-Agent Prompt (fix task)

For fix tasks dispatched from the review loop:

```
You are running the task-implementer skill in FIX MODE (AUTONOMOUS).
DO NOT ask the user any questions. Execute the full workflow end-to-end.

Load the skill: task-implementer (from skills/gdskills/orchestration/task-implementer/SKILL.md)

═══════════════════════════════════════════════
  FIX TASK
═══════════════════════════════════════════════

{
  "task_id": "fix-<ITERATION>",
  "task_name": "Fix review findings — iteration <ITERATION>",
  "task_type": "fix",
  "complexity": "medium",
  "dependencies": [],
  "description": "Fix review findings from iteration <ITERATION>",
  "target_files": [<FILES_WITH_FINDINGS>],
  "acceptance_criteria": ["All CRITICAL and WARNING findings resolved"],
  "context": "",
  "existing_tests": [],
  "existing_stories": [],
  "module_patterns": ""
}

FIX_CONTEXT:
{
  "review_feedback": <REVIEW_FINDINGS_JSON>,
  "original_task_ids": [<ORIGINAL_TASK_IDS>],
  "iteration": <ITERATION_NUMBER>
}

WORKSPACE: (same as above)

AUTOMATION SETTINGS: (same as above)

EXECUTION INSTRUCTIONS: (same as above — including the Phase 6 validate/record
pair, and the compact STATUS response as the FINAL MESSAGE with NO inline JSON.
`parseChildResult` throws on any first line that is not `STATUS: <TOKEN>`, so a
returned JSON object is not a result the orchestrator can read.)
```

---

## Example Task Tool Call

```javascript
Task({
  description: "Implement task-1: <TASK_NAME>",
  subagent_type: "general-purpose",
  prompt: "<generated prompt from template above>"
})
```

---

## Parsing the Result

After receiving the sub-agent STATUS response, the orchestrator must:

1. Read the STATUS line: `DONE` | `DONE_WITH_CONCERNS` | `BLOCKED`
2. Extract compact summary from the response:
   - Files changed section
   - Verification results
   - Commits (from "Completed" bullets or result file)
3. **Read the result file** only when needed (DONE_WITH_CONCERNS or BLOCKED):
   - Path: `<JOBS_ROOT>/<JOB_NAME>/results/<task_id>.json`
   - Fields: task_id, status, files_modified, files_created, commits, lint_result, type_check_result, test_result, acceptance_criteria_met
4. Decision based on STATUS:
   - `DONE` → continue, collect commit hashes from response
   - `DONE_WITH_CONCERNS` → read result file, log concerns, continue
   - `BLOCKED` → STOP the wave and report the reason; the `implement` step stays
     open, and `keryx job complete` refuses while it is

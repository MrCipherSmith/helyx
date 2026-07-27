# Context Collector — Orchestrator Prompt Template

<!--
  PURPOSE
  =======
  This prompt is used by job-orchestrator to dispatch context-collector
  as a sub-agent WITHOUT interactivity. The orchestrator:
  1. Determines the action (collect | update) based on job state
  2. Fills in the template placeholders from job context
  3. Dispatches the sub-agent via Task tool
  4. Parses the returned CONTEXT_RESULT block

  DATA FLOW
  =========
  [Orchestrator] → builds prompt → Task(subagent)
                   ↓
  [Sub-agent]   → loads SKILL.md, executes all phases autonomously
                   ↓
  [Result]      → CONTEXT_RESULT block (in sub-agent final message)
-->

## Usage

Use this template when dispatching context-collector as a sub-agent from job-orchestrator.

Typical call point in the job plan: **after issue-analyzer, before task-implementer**.

---

## Step 1: Validate Inputs

Before dispatching, assert:

```
ASSERT JOB_NAME is not empty          → else ABORT("JOB_NAME required")
ASSERT PROJECT_DIR is not empty       → else ABORT("PROJECT_DIR required")
ASSERT DATA.TASK_DESCRIPTION is not empty → else ABORT("TASK_DESCRIPTION required")
IF ACTION == "update":
  ASSERT DATA.UPDATE_REASON is not empty → else ABORT("UPDATE_REASON required for update action")
```

---

## Step 2: Choose the Correct Template

| Condition | Template to use |
|-----------|----------------|
| No `context.md` exists for the job | ACTION: collect |
| `context.md` exists and needs refreshing | ACTION: update |
| New library or pattern discovered mid-job | ACTION: update |
| Sub-agent reports insufficient context | ACTION: update |

---

## Prompt Template (ACTION: collect)

```
You are the context-collector agent. Your task is to research and build
a context document for the current job.

Load the skill from: skills/context-collector/SKILL.md

DO NOT ask the user any questions. Execute all phases autonomously.

ACTION: collect
JOB_NAME: {{JOB_NAME}}
JOBS_ROOT: <JOBS_ROOT>
PROJECT_DIR: {{PROJECT_DIR}}

DATA:
  TASK_DESCRIPTION: {{TASK_DESCRIPTION}}
  FOCUS_AREAS: {{FOCUS_AREAS}}
  ANALYSIS_RESULT: {{ANALYSIS_RESULT_PATH_OR_CONTENT}}
  KNOWN_LIBRARIES: {{KNOWN_LIBRARIES}}

Execute all phases (RECEIVE → LOCAL → EXTERNAL → SYNTHESIZE → DOCUMENT)
and return a CONTEXT_RESULT block as your final message.
```

---

## Prompt Template (ACTION: update)

```
You are the context-collector agent. Your task is to update the existing
context document for this job.

Load the skill from: skills/context-collector/SKILL.md

DO NOT ask the user any questions. Execute the update flow autonomously.

ACTION: update
JOB_NAME: {{JOB_NAME}}
JOBS_ROOT: <JOBS_ROOT>
PROJECT_DIR: {{PROJECT_DIR}}

DATA:
  TASK_DESCRIPTION: {{ORIGINAL_TASK_DESCRIPTION}}
  UPDATE_REASON: {{WHY_UPDATE_NEEDED}}
  FOCUS_AREAS: {{NEW_AREAS_TO_RESEARCH}}

Execute the update flow (read existing context → scoped LOCAL + EXTERNAL →
SYNTHESIZE merge → DOCUMENT with incremented version) and return a
CONTEXT_RESULT block as your final message.
```

---

## Example Task Tool Call

```javascript
Task({
  description: "context-collector: collect context for {{JOB_NAME}}",
  subagent_type: "general",
  prompt: "<generated prompt from template above>"
})
```

---

## Expected Response Format

The sub-agent MUST return a CONTEXT_RESULT block as the last structured
output in its final message:

```
CONTEXT_RESULT:
  action:       collect | update
  status:       success | error
  job_name:     <JOB_NAME or null>
  context_path: <JOBS_ROOT>/{{JOB_NAME}}/ai/context.md
  version:      <document version, e.g. 1.0>
  summary:      <2-3 sentences describing what was collected>
  sections_collected:
    - Task Overview
    - Key Decisions & Constraints
    - Applicable Rules & Conventions
    - Codebase Patterns
    - Libraries & APIs
    - Best Practices
    - References
  sections:
    local_sources:        <count>
    external_sources:     <count>
    rules_applied:        <count>
    libraries_documented: <count>
  errors:
    - phase:        <RECEIVE | LOCAL | EXTERNAL | SYNTHESIZE | DOCUMENT>
      source:       <url or file path, if applicable>
      message:      <what went wrong>
      action_taken: <how it was handled>
  error_details: <present only if status is error>
```

---

## Parsing the Result (Orchestrator)

After receiving the sub-agent response, the orchestrator must:

1. Extract the `CONTEXT_RESULT` block from the final message
2. Check `status`:
   - `success` → proceed to next job step, pass `context_path` to downstream agents
   - `error` → log `error_details`, decide whether to abort job or continue without context
3. Log `context_path` and `version` in the job's run log
4. Pass `context_path` to all subsequent sub-agents (task-implementer, pr-creator, etc.)
   so they can load the context document before executing their own phases

---

## Placeholder Reference

| Placeholder | Source | Required |
|-------------|--------|----------|
| `{{JOB_NAME}}` | Job orchestrator state | Yes |
| `{{PROJECT_DIR}}` | Job orchestrator state | Yes |
| `{{TASK_DESCRIPTION}}` | Issue description or user input | Yes |
| `{{FOCUS_AREAS}}` | Analysis result or user-specified focus | No |
| `{{ANALYSIS_RESULT_PATH_OR_CONTENT}}` | Output from issue-analyzer step | No |
| `{{KNOWN_LIBRARIES}}` | Extracted from analysis or package.json pre-scan | No |
| `{{ORIGINAL_TASK_DESCRIPTION}}` | Stored from initial collect call | Yes (update only) |
| `{{WHY_UPDATE_NEEDED}}` | Triggering condition detected by orchestrator | Yes (update only) |
| `{{NEW_AREAS_TO_RESEARCH}}` | Derived from trigger event (new library, review finding) | No |

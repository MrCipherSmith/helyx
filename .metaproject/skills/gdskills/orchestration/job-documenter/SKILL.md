---
name: job-documenter
description: "Use when a job folder needs to be initialized, or analysis/report/review documents need to be created or updated in jobs/."
triggers:
  - "Document job"
  - "Initialize job folder"
  - "Save job report"
  - "Add job document"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "documentation"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely.
This skill is for orchestrators and interactive session-level routing only.
Proceed directly with your assigned task.
</SUBAGENT-STOP>

# Job Documenter

> **JOBS_ROOT Note:** `JOBS_ROOT` is always passed explicitly by the orchestrator in the dispatch prompt. Never resolve it yourself — do not fall back to any hardcoded path.

## Purpose

Sub-agent responsible for creating and maintaining structured job documentation in `<JOBS_ROOT>/`. Called exclusively by `job-orchestrator` to persist the lifecycle of orchestrated tasks — from initial plan through analysis, implementation, review, and final report.

**This skill is NOT invoked directly by users.** It is a service skill dispatched by the orchestrator.

**Input:** Action type + job name + content payload (from orchestrator)
**Output:** Status report (success/error) + created file paths

## When to Use

- Called by `job-orchestrator` during pipeline execution
- When orchestrator needs to initialize a new job folder
- When orchestrator needs to save a sub-agent result as a document
- When orchestrator needs to update job README or finalize a job

## Reference Rule

All structural conventions are defined in `rules/core/jobs-documentation.mdc`. This skill MUST follow that rule exactly.

## Input Contract

The orchestrator provides a structured prompt with the following fields:

```
ACTION:    init | add-document | update-readme | finalize
JOB_NAME:  <kebab-case folder name>
JOBS_ROOT: <JOBS_ROOT>
DATA:      <action-specific payload — see below>
```

---

## Actions

### Action: `init`

Initialize a new job folder with required structure.

**Input DATA:**
```
TITLE:       <Job title — human-readable>
DESCRIPTION: <1-3 sentences describing what this job does>
INTENT:      <analyze | implement | review | custom>
SOURCE:      <issue URL, PR URL, branch name, or free-text description>
PROJECT:     <absolute path to project directory>
BRANCH:      <feature branch name, if known — may be "TBD">
BASE_BRANCH: <base branch name>
PLAN:        <ordered list of planned steps>
```

**Procedure:**

1. **Create directory structure:**
   ```
   .metaproject/jobs/<JOB_NAME>/
     README.md
     man/
     ai/
   ```

2. **Write README.md** following the format from `jobs-documentation.mdc`:
   - Status: `in-progress`
   - Created/Updated: current ISO 8601 UTC timestamp
   - Fill Context table from input DATA
   - Plan section from input PLAN (all items unchecked)
   - Empty Agents Used table
   - Empty Documents tables
   - Empty Problems & Notes

3. **Write `ai/plan.md`** — structured version of the plan:
   ```markdown
   # Execution Plan

   ## Steps
   | Step | Type | Agent | Dependencies | Status |
   |------|------|-------|-------------|--------|
   | 1 | analyze | issue-analyzer | none | pending |
   | 2 | prepare | orchestrator | 1 | pending |
   | ... | ... | ... | ... | ... |

   ---

   <!-- Document Metadata -->
   | Key | Value |
   |-----|-------|
   | Created | <timestamp> |
   | Agent | job-orchestrator |
   | Task | Initialize job plan |
   | Job | <JOB_NAME> |
   | Version | 1.0 |
   | Status | final |
   ```

4. **Write `man/plan.md`** — human-readable version of the plan:
   ```markdown
   # Execution Plan: <TITLE>

   ## Overview
   <DESCRIPTION>

   ## Steps

   1. **<Step name>** — <description>
      - Agent: <agent name>
      - Dependencies: <deps or "none">

   2. ...

   ---

   <!-- Document Metadata -->
   | Key | Value |
   |-----|-------|
   | Created | <timestamp> |
   | Agent | job-orchestrator |
   | Task | Initialize job plan |
   | Job | <JOB_NAME> |
   | Version | 1.0 |
   | Status | final |
   ```

5. **Update README.md** — add plan.md entries to Documents tables.

6. **Verify:**
   - Read directory listing of `.metaproject/jobs/<JOB_NAME>/`
   - Confirm: `README.md`, `man/`, `ai/`, `man/plan.md`, `ai/plan.md` all exist
   - If any missing → report error

7. **Return result:**
   ```
   DOCUMENTER_RESULT:
     action: init
     status: success | error
     job_path: <JOBS_ROOT>/<JOB_NAME>
     files_created: [README.md, man/plan.md, ai/plan.md]
     error_details: <if status is error>
   ```

---

### Action: `add-document`

Add a new document to an existing job.

**Input DATA:**
```
DOC_TYPE:    <analysis | report | review | context | implementation-report | final-report | improvements | requirements | error-log | tasks.feature | review-findings | custom>
DOC_NAME:    <file name without extension, kebab-case — used if DOC_TYPE is "custom">
TARGET:      man | ai | both
TITLE:       <document title>
CONTENT:     <full document content — markdown>
AGENT:       <which agent produced this content>
TASK:        <which task/phase this relates to>
VERSION:     <document version, default "1.0">
DOC_STATUS:  <draft | final>
```

**Procedure:**

1. **Determine file name:**
   - If DOC_TYPE is a standard type → use standard name from `jobs-documentation.mdc` (e.g. `analysis.md`, `report.md`)
   - If DOC_TYPE is `tasks.feature` → use `tasks.feature` (ai/ only)
   - If DOC_TYPE is `custom` → use DOC_NAME + `.md`

2. **Determine target directories:**
   - `TARGET=man` → write to `man/` only
   - `TARGET=ai` → write to `ai/` only
   - `TARGET=both` → write to both `man/` and `ai/`

3. **For each target directory, write the document:**
   ```markdown
   # <TITLE>

   <CONTENT>

   ---

   <!-- Document Metadata -->
   | Key | Value |
   |-----|-------|
   | Created | <current ISO 8601 UTC timestamp> |
   | Agent | <AGENT> |
   | Task | <TASK> |
   | Job | <JOB_NAME> |
   | Version | <VERSION> |
   | Status | <DOC_STATUS> |
   ```

4. **Update README.md:**
   - Add entry to the appropriate Documents table(s) (`man/` and/or `ai/`)
   - Entry format: `| [<filename>](<target>/<filename>) | <TITLE> | <DOC_STATUS> |`

5. **Verify:**
   - Confirm each written file exists by reading directory listing
   - Confirm README.md was updated (contains the new file reference)

6. **Return result:**
   ```
   DOCUMENTER_RESULT:
     action: add-document
     status: success | error
     files_created: [<list of created file paths>]
     readme_updated: true | false
     error_details: <if status is error>
   ```

---

### Action: `update-readme`

Refresh the README to reflect current state.

**Input DATA:**
```
PLAN_UPDATES:  <optional — list of step statuses to update: [{step: 1, status: "completed"}, ...]>
AGENTS_UPDATE: <optional — list of agent entries to add/update: [{agent, phase, status}, ...]>
PROBLEMS:      <optional — list of problems/notes to add>
BRANCH_UPDATE: <optional — branch name if it was TBD during init>
```

**Procedure:**

1. **Read current README.md** from `.metaproject/jobs/<JOB_NAME>/README.md`

2. **Apply updates:**
   - Update plan checkboxes based on PLAN_UPDATES (`[ ]` → `[x]` for completed steps)
   - Add/update rows in Agents Used table
   - Append to Problems & Notes section
   - Update Branch in Context table if BRANCH_UPDATE provided
   - Update `**Updated:**` timestamp

3. **Re-scan `man/` and `ai/` directories** to ensure Documents tables are complete:
   - List all files in `man/` and `ai/`
   - If any file exists that is NOT in the Documents table → add it with description "Auto-discovered"
   - If any table entry references a file that doesn't exist → mark as "(missing)"

4. **Write updated README.md**

5. **Return result:**
   ```
   DOCUMENTER_RESULT:
     action: update-readme
     status: success | error
     updates_applied: [<list of what was updated>]
     error_details: <if status is error>
   ```

---

### Action: `finalize`

Mark the job as completed.

**Input DATA:**
```
FINAL_CONTENT: <optional — final report content to save as final-report.md>
FINAL_STATUS:  completed | aborted
SUMMARY:       <1-3 sentence summary of what was accomplished>
```

**Procedure:**

1. **If FINAL_CONTENT is provided:**
   - Write `man/final-report.md` and `ai/final-report.md` with metadata (same as `add-document` procedure)
   - Update README Documents tables

2. **Update README.md:**
   - Set Status to FINAL_STATUS
   - Update `**Updated:**` timestamp
   - Mark all plan steps as completed (or appropriate status)
   - Add SUMMARY to Description section (or as a "## Outcome" section at the end)

3. **Full verification:**
   - Read directory listing of `.metaproject/jobs/<JOB_NAME>/`, `man/`, `ai/`
   - Cross-check every entry in README Documents tables against actual files
   - Report any discrepancies

4. **Return result:**
   ```
   DOCUMENTER_RESULT:
     action: finalize
     status: success | error
     job_path: <JOBS_ROOT>/<JOB_NAME>
     final_status: <FINAL_STATUS>
     total_documents: <count of all files in man/ + ai/>
     verification: passed | <list of discrepancies>
     error_details: <if status is error>
   ```

---

## Error Handling

If any file operation fails during any action:

1. **Attempt to create error log:**
   - Write `man/error-log.md` with error details, timestamp, which action was being performed
   - If this also fails, report the raw error in the return result

2. **Return error status:**
   ```
   DOCUMENTER_RESULT:
     action: <action>
     status: error
     error_details: <what went wrong>
     error_log_created: true | false
   ```

3. **Do NOT throw/crash** — always return a structured result so the orchestrator can decide how to proceed.

---

## Prompt Template for Orchestrator

When the orchestrator dispatches this skill as a sub-agent, it should use this prompt structure:

```
You are the job-documenter agent. Your task is to manage job documentation.

Load the skill from: skills/job-documenter/SKILL.md
Follow the rules from: rules/core/jobs-documentation.mdc

ACTION: <action>
JOB_NAME: <job-name>
JOBS_ROOT: <JOBS_ROOT>

DATA:
<action-specific data>

Execute the action and return a DOCUMENTER_RESULT block.
```

---

## Rules of Engagement

1. **DO** follow `jobs-documentation.mdc` for all structural decisions.
2. **DO** add metadata blocks to every document.
3. **DO** verify file existence after every write operation.
4. **DO** keep README.md in sync with actual directory contents.
5. **DO** use ISO 8601 UTC timestamps everywhere.
6. **DO** return structured DOCUMENTER_RESULT for every action.
7. **DO NOT** create files outside of `.metaproject/jobs/<JOB_NAME>/`.
8. **DO NOT** delete or overwrite existing documents without explicit instruction.
9. **DO NOT** modify files in other job folders.
10. **DO NOT** interact with the user directly — all communication goes through the orchestrator.

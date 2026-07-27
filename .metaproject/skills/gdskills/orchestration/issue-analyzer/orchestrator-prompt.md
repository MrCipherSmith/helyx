# Issue Analyzer — Orchestrator Prompt

> **Purpose:** Template used by `job-orchestrator` to dispatch `issue-analyzer` as a sub-agent.
> The orchestrator fills in the placeholders below and sends the result as a Task prompt.
> The issue-analyzer executes SKILL.md autonomously and returns a JSON analysis result.

## Data Flow

```
[Orchestrator] → fills template → Task(sub-agent)
                                        ↓
[Sub-agent]    → executes issue-analyzer SKILL.md autonomously
                                        ↓
[Result]       → JSON analysis object (in final message)
```

## Step 1: Collect Parameters

Extract from input (filled issue-request or direct parameters):

```
ISSUE:
  url              → GitHub issue URL
  repo             → owner/repo (if no url)
  number           → issue number (if no url)
  title            → fallback title (if gh CLI unavailable)
  description      → fallback description (if gh CLI unavailable)

CODEBASE_PATHS:
  [{path, role, branch}, ...]

FOCUS (optional):
  keywords         → additional keywords
  directories      → priority directories

AUTOMATION:
  max_tasks        → max number of tasks (default: 7)
  search_depth     → search depth (default: focused)
  include_context  → include code context (default: true)
  timeout_strategy → timeout strategy (default: partial)
  gh_cli_fallback  → fallback if gh CLI unavailable (default: skip_enrichment)
```

## Step 2: Validate

```
ASSERT issue.url OR (issue.repo AND issue.number)  → otherwise ABORT: "Issue not specified"
ASSERT codebase_paths.length >= 1                  → otherwise ABORT: "No codebase paths"
ASSERT each codebase_paths[*].path is not empty    → otherwise ABORT: "Empty codebase path"
ASSERT each codebase_paths[*].role in [frontend, backend, shared] → otherwise ABORT: "Invalid role"
```

## Step 3: Build Sub-Agent Prompt

Fill in the template below and launch via Task tool.

---

## Sub-Agent Prompt Template

```
You are running the issue-analyzer skill in AUTONOMOUS MODE.
DO NOT ask the user any questions. Execute the full workflow end-to-end.

Load the skill: issue-analyzer (from skills/issue-analyzer/SKILL.md)

═══════════════════════════════════════════════
  INPUT PARAMETERS
═══════════════════════════════════════════════

GITHUB ISSUE:
<!-- If issue URL is provided: -->
  URL: <ISSUE_URL>
  → Parse owner/repo and number from URL

<!-- If no URL, use repo + number: -->
  Repo:   <ISSUE_REPO>
  Number: <ISSUE_NUMBER>

<!-- If gh CLI may be unavailable, provide fallback: -->
FALLBACK DATA (use only if gh CLI is unavailable):
  Title:       <ISSUE_TITLE>
  Description: <ISSUE_DESCRIPTION>

CODEBASE PATHS:
<!-- For each codebase path: -->
  - Path:   <CODEBASE_PATH_1>
    Role:   <frontend|backend|shared>
    Branch: <BRANCH_1> (or "current HEAD" if not specified)

  - Path:   <CODEBASE_PATH_2> (if applicable)
    Role:   <role>
    Branch: <BRANCH_2>

<!-- If focus area specified: -->
FOCUS AREA:
  Keywords:    <FOCUS_KEYWORDS> (or "none")
  Directories: <FOCUS_DIRECTORIES> (or "none")

═══════════════════════════════════════════════
  AUTOMATION SETTINGS
═══════════════════════════════════════════════

1. CONFIRMATION: SKIP. Proceed immediately.
2. MAX TASKS: <MAX_TASKS> (default: 7)
3. SEARCH DEPTH: <SEARCH_DEPTH> (default: focused)
4. INCLUDE CONTEXT: <INCLUDE_CONTEXT> (default: true)
5. TIMEOUT: <TIMEOUT_STRATEGY> (default: partial)
6. GH CLI FALLBACK: <GH_CLI_FALLBACK> (default: skip_enrichment)

═══════════════════════════════════════════════
  EXECUTION INSTRUCTIONS
═══════════════════════════════════════════════

1. Load issue-analyzer SKILL.md
2. Execute all 4 phases: COLLECT → ANALYZE → DECOMPOSE → FORMALIZE
3. Return the JSON analysis object as your FINAL MESSAGE
4. The JSON output must be parseable and match the output contract:
   - Top-level keys: issue, tasks, dependency_order
   - issue.number: integer
   - tasks: array with task_id format "task-N"
   - dependency_order: topologically sorted task IDs
5. Precede the JSON with a brief summary:
   - Issue type (bug/feature/enhancement/refactoring/chore)
   - Number of tasks
   - Overall complexity estimate

DO NOT ask questions. DO NOT stop for user input. Run to completion.
```

---

## Example Task Tool Call

```javascript
Task({
  description: "Issue analysis: #4141",
  subagent_type: "general",
  prompt: "<generated prompt from template above>"
})
```

---

## Parsing the Result (orchestrator)

After receiving the sub-agent response, the orchestrator must:

1. Extract the JSON object from the response (between ```json and ```)
2. Parse into ANALYSIS_RESULT:
   - `issue.number`, `issue.title`, `issue.type`, `issue.intent`
   - `tasks`: array of task objects, each with task_id, task_name, task_type, complexity, dependencies, description, target_files, acceptance_criteria, context
   - `dependency_order`: already topologically sorted — use this order for task dispatch
3. Validate: at least 1 task, no circular dependencies, all dependency references valid
4. Pass each task to task-implementer in dependency_order

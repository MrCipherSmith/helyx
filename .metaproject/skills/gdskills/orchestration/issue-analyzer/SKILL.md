---
name: issue-analyzer
description: "Use when decomposing a GitHub issue into atomic tasks for AI implementation, planning task breakdown, or preparing work for task-implementer agents."
triggers:
  - "Analyze issue"
  - "Decompose issue"
  - "Break down issue"
  - "Issue to tasks"
  - "Plan issue implementation"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "analysis"
  agent_worthy: true
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Issue Analyzer

## Purpose

Analyzes a GitHub issue and decomposes it into atomic implementation tasks that can be dispatched to `task-implementer` sub-agents. Designed to run autonomously as a sub-agent — no user interaction required.

**Input:** GitHub issue URL (or repo + number) + codebase path(s)
**Output:** JSON analysis object with one task entry per atomic task, each containing full context for implementation

## When to Use

- Orchestrator needs to break an issue into implementable tasks
- Planning AI-driven implementation of a GitHub issue
- Understanding scope and affected areas before coding

## Architecture: 4 Phases

```
Phase 1: COLLECT   →  Fetch all issue data from GitHub
Phase 2: ANALYZE   →  Extract intent, find affected code areas
Phase 3: DECOMPOSE →  Break into atomic tasks with dependencies
Phase 4: FORMALIZE →  Emit structured JSON analysis object
```

---

## Workflow

```
Issue Analyzer Progress:
- [ ] Phase 1: Collect issue data from GitHub
- [ ] Phase 2: Analyze intent and search codebase
- [ ] Phase 3: Decompose into atomic tasks
- [ ] Phase 4: Formalize as JSON output
```

### Phase 1: COLLECT

Fetch all available data about the issue using `gh` CLI.

**1.1 Core issue data:**
```bash
gh issue view <NUMBER> --repo <OWNER/REPO> --json title,body,state,labels,assignees,milestone,comments,projectItems
```

**1.2 Timeline events (cross-references, linked PRs, assignments):**
```bash
gh api repos/<OWNER>/<REPO>/issues/<NUMBER>/timeline --paginate
```

**1.3 Comments (full thread):**
```bash
gh api repos/<OWNER>/<REPO>/issues/<NUMBER>/comments --paginate
```

**1.4 Sub-issues (if any, via GraphQL):**
```bash
gh api graphql -f query='
  query {
    repository(owner: "<OWNER>", name: "<REPO>") {
      issue(number: <NUMBER>) {
        subIssues(first: 50) {
          nodes { number title state url }
        }
        parent { number title url }
      }
    }
  }
'
```

**1.5 Linked documents:**
- Extract URLs from issue body and comments
- If URLs point to GitHub files, fetch their content
- If URLs point to docs, fetch via WebFetch

**Output of Phase 1:** Structured issue context object:
```
ISSUE_CONTEXT:
  number: <N>
  title: <string>
  body: <markdown>
  labels: [<string>]
  assignees: [<string>]
  comments: [{author, body, created_at}]
  cross_references: [{source, type}]
  sub_issues: [{number, title, state}]
  parent_issue: {number, title} | null
  linked_urls: [<url>]
```

### Phase 2: ANALYZE

**2.1 Extract intent from issue body:**
- Issue type: `bug` | `feature` | `enhancement` | `refactoring` | `chore`
- Expected behavior (from "Expected" / "Should" sections)
- Steps to reproduce (from "Steps" / "How to reproduce" sections)
- Acceptance criteria (from "AC" / "Criteria" / "Definition of Done" sections)
- If no explicit AC — derive from description and expected behavior

**2.2 Search codebase for affected areas:**

Using the codebase path(s) from input, search for relevant files:

```
For each keyword extracted from issue title + body:
  1. Use `find_by_name` (or similar file search tool) to find files matching names.
  2. Use `grep_search` to find files containing matching patterns (avoid using standard bash `grep` if the IDE provides a native tool).
  3. Track: file path, line numbers, relevance score
```

**Priority classification:**
- **P0** (must change): Files directly mentioned in issue, files containing the buggy behavior
- **P1** (likely change): Files in the same module/directory, related types/interfaces
- **P2** (may need update): Tests, stories, docs for P0/P1 files

**2.3 Analyze module structure:**
- Read P0 files:
  - For small/medium files: read fully via `view_file`.
  - For large files (> 500 lines): DO NOT read fully to avoid context exhaustion. Use `view_file_outline` or `grep_search` to locate specific relevant class/function signatures.
- Identify: imports, exports, types, class/function signatures
- Map dependencies between files
- Identify existing tests and stories for affected components

**Output of Phase 2:** Analysis summary:
```
ANALYSIS:
  issue_type: <bug|feature|enhancement|refactoring|chore>
  intent: <1-2 sentence summary>
  acceptance_criteria: [<string>]
  affected_files:
    p0: [{path, reason, key_symbols}]
    p1: [{path, reason}]
    p2: [{path, reason}]
  module_map: {module_name: [files]}
  existing_tests: [<path>]
  existing_stories: [<path>]
```

### Phase 3: DECOMPOSE

Break the issue into atomic, implementable tasks.

**3.1 Decomposition rules:**
- Each task should be completable by a single agent in one session
- Each task should touch a minimal, cohesive set of files
- Tasks should follow the 3-layer architecture order when possible:
  1. Service/API layer changes first
  2. Store/logic layer changes second
  3. Component/UI layer changes third
  4. Tests and stories last (or inline with their layer)
- Maximum 7 tasks per issue (if more needed, the issue is too large)

**3.2 Determine task type for each task:**

| Task Type | Description | Required Outputs |
|-----------|-------------|-----------------|
| `ui_component` | New or modified React component | Code + Story + Screenshot test |
| `store_logic` | MobX store changes | Code + Unit test |
| `service_api` | API service / DTO changes | Code + Unit test |
| `refactoring` | Code restructuring | Code + Verify existing tests pass |
| `fix` | Bug fix | Code + Regression test |
| `mixed` | Crosses multiple layers | Code + Tests appropriate to each layer |

**3.3 Assign dependencies:**
- If task-2 imports types from task-1's new code → task-2 depends on task-1
- If task-3 tests code from task-2 → task-3 depends on task-2
- No circular dependencies allowed

**Output of Phase 3:** Task list:
```
TASKS:
  - id: task-1
    name: <descriptive name>
    task_type: <enum>
    description: <what to do>
    target_files: [<path>]
    acceptance_criteria: [<string>]
    dependencies: []
    estimated_complexity: low | medium | high
  - id: task-2
    ...
```

### Phase 4: FORMALIZE

Convert the task list into a structured JSON object for reliable machine parsing.

**Output structure:**

```json
{
  "issue": {
    "number": "<issue_number>",
    "title": "<issue_title>",
    "type": "<bug|feature|enhancement|refactoring|chore>",
    "repo": "<owner/repo>",
    "intent": "<1-2 sentence intent summary>",
    "labels": ["<label1>", "<label2>"],
    "assignees": ["<user1>"],
    "total_tasks": "<N>"
  },
  "tasks": [
    {
      "task_id": "task-1",
      "task_name": "<Descriptive Task Name>",
      "task_type": "<ui_component|store_logic|service_api|refactoring|fix|mixed>",
      "complexity": "<low|medium|high>",
      "dependencies": [],
      "description": "<full description of what to implement>",
      "target_files": ["src/path/file.ts"],
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "context": "<relevant code context, key types, function signatures>",
      "existing_tests": ["src/path/file.test.ts"],
      "existing_stories": [],
      "module_patterns": "<how similar code is written in this module>",
      "requires_tests_creator": true
    },
    {
      "task_id": "task-2",
      "task_name": "<Descriptive Task Name>",
      "task_type": "<type>",
      "complexity": "<low|medium|high>",
      "dependencies": ["task-1"],
      "description": "<description>",
      "target_files": ["src/path/other.ts"],
      "acceptance_criteria": ["criterion 1"],
      "context": "<context>",
      "existing_tests": [],
      "existing_stories": [],
      "module_patterns": "<patterns>",
      "requires_tests_creator": true
    }
  ],
  "dependency_order": ["task-1", "task-2"]
}
```

**Each task object is the explicit context for task-implementer.**

When `job-orchestrator` dispatches `task-implementer`, it passes the task object directly as the subagent's context. This means:
- `task.context`, `task.target_files`, and `task.acceptance_criteria` are **required fields** — never omit or leave them empty when the information exists.
- `task.context` must contain enough information for the implementer to start without reading the full codebase: key types, function signatures, relevant patterns, and any design decisions.
- `task.module_patterns` must describe how similar code is written nearby — the implementer uses this for style consistency.

**Red Flag: "The implementer can figure out the context from the codebase"**

→ It cannot — not reliably. An implementer with no context will make assumptions, produce inconsistent code, or ask questions. Every omitted field is a gap the implementer will fill with a guess.

## Reporting Results

Every final response to the orchestrator MUST begin with `STATUS: DONE` or `STATUS: BLOCKED`.

```
STATUS: DONE

## Analysis
[structured JSON analysis object]
```

Use `STATUS: BLOCKED` only if the issue cannot be fetched (404) or the codebase cannot be accessed.

**IRON LAW: THE FIRST LINE OF YOUR FINAL RESPONSE IS ALWAYS "STATUS: DONE" OR "STATUS: BLOCKED". THE JSON ANALYSIS FOLLOWS AFTER.**

**Rules for JSON output:**
- `dependency_order` must be topologically sorted — tasks with no dependencies come first
- `task_id` format: `task-1`, `task-2`, ... (sequential)
- `dependencies` lists task_ids that must complete before this task
- All string arrays may be empty `[]` but not omitted
- `context` and `module_patterns` may be empty string if not applicable
- `requires_tests_creator` is always `true` — orchestrator must dispatch `tests-creator` before `task-implementer` for each task
- Output the JSON block as the **final message** to the orchestrator, preceded by a brief summary (issue type, number of tasks, overall complexity)

**Return format** (final message to orchestrator):
```
Analysis complete.
- Issue type: <type>
- Total tasks: <N>
- Overall complexity: <low|medium|high>
- Dependency order: task-1 → task-2 → task-3

<json block>
```

---

## Automation Settings

This skill is designed to run fully autonomously. The following settings control behavior:

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `max_tasks` | `7` | 1-10 | Maximum number of tasks to decompose into |
| `search_depth` | `focused` | `shallow` / `focused` / `deep` | How deeply to search codebase |
| `include_context` | `true` | true/false | Include code context (types, signatures) in output |
| `timeout_strategy` | `partial` | `partial` / `abort` | What to do if analysis takes too long |
| `gh_cli_fallback` | `skip_enrichment` | `skip_enrichment` / `abort` | What to do if gh CLI is unavailable |

---

## Error Handling

| Error | Action |
|-------|--------|
| Issue not found (404) | ABORT with error message |
| Issue body is empty | Analyze from title + comments only. Add note in output. |
| No codebase match found | Return empty task list with note "No matching code found" |
| gh CLI not available | Use provided issue data from input (title, description fallback) |
| Too many affected files (>50) | Filter to P0 only, cap at max_tasks |
| Issue is too large (>7 tasks) | Split into top-level tasks, note "consider splitting issue" |

---

## Rules of Engagement

1. **DO NOT** ask the user any questions. All input comes from the input contract.
2. **DO NOT** modify any files. This is a read-only analysis skill.
3. **DO NOT** make assumptions about implementation approach — describe WHAT, not HOW.
4. **DO** include enough context in each task entry for a task-implementer to start without asking questions.
5. **DO** respect the 3-layer architecture: Service → Store → Component ordering.
6. **DO** identify existing tests and stories so implementer knows what to update.
7. **DO** note module patterns (how similar code is written nearby) for consistency.
8. Return the JSON analysis result as your **final message** to the orchestrator.

---

## Red Flags — Stop and re-read this skill if you are thinking:

| Rationalization | Why it's wrong |
|---|---|
| "The issue title is clear enough, I'll skip reading the full body" | Acceptance criteria, repro steps, and constraints live in the body — the title is just a label |
| "I know this codebase, I don't need to search for affected files" | Prior knowledge drifts; the search step catches files that have changed since you last looked |
| "I'll create one big task instead of decomposing — simpler to track" | A monolithic task cannot be parallelized or independently verified; it defeats the whole system |
| "The dependencies between tasks seem obvious, no need to map them" | Untracked dependencies cause agents to overwrite each other's work or build on stale code |
| "The issue body is mostly boilerplate, I've got the gist" | Edge cases and acceptance criteria are often buried in what looks like boilerplate |

**IRON LAW: ALWAYS READ THE FULL ISSUE BODY AND SEARCH THE CODEBASE BEFORE DECOMPOSING INTO TASKS.**

## Job Context Awareness

When dispatched by `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
JOBS_ROOT:    <JOBS_ROOT>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If `CONTEXT_PATH` is provided and the file exists, read it during Phase 2 (ANALYZE) to:
- Understand existing project conventions and patterns
- Identify relevant library documentation and best practices
- Avoid duplicating research already captured in the context document
- Use the context to improve the quality of task decomposition (e.g., better target_files, richer module_patterns)

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.

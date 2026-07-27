---
name: issue-analyzer
description: "Autonomous GitHub issue analysis and decomposition into atomic implementation tasks. Fetches issue data via gh CLI, analyzes codebase for affected areas, decomposes into Gherkin Scenarios with full context for implementer sub-agents. Use when: decomposing issues for AI implementation, planning task breakdown, preparing work for task-implementer agents."
triggers:
  - "Analyze issue"
  - "Decompose issue"
  - "Break down issue"
  - "Issue to tasks"
  - "Plan issue implementation"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "analysis"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Issue Analyzer

## Purpose

Analyzes a GitHub issue and decomposes it into atomic implementation tasks that can be dispatched to `task-implementer` sub-agents. Designed to run autonomously as a sub-agent — no user interaction required.

**Input:** GitHub issue URL (or repo + number) + codebase path(s)
**Output:** Gherkin Feature with one Scenario per task, each containing full context for implementation

## When to Use

- Orchestrator needs to break an issue into implementable tasks
- Planning AI-driven implementation of a GitHub issue
- Understanding scope and affected areas before coding

## Architecture: 4 Phases

```
Phase 1: COLLECT   →  Fetch all issue data from GitHub
Phase 2: ANALYZE   →  Extract intent, find affected code areas
Phase 3: DECOMPOSE →  Break into atomic tasks with dependencies
Phase 4: FORMALIZE →  Emit Gherkin Feature with Scenarios
```

---

## Workflow

```
Issue Analyzer Progress:
- [ ] Phase 1: Collect issue data from GitHub
- [ ] Phase 2: Analyze intent and search codebase
- [ ] Phase 3: Decompose into atomic tasks
- [ ] Phase 4: Formalize as Gherkin output
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

Convert the task list into Gherkin Feature format.

**Output structure:**

```gherkin
Feature: Issue #<N> — <Issue Title>

  Background: Issue Context
    Given GitHub issue #<N> "<title>"
    And issue type is "<issue_type>"
    And repository "<owner/repo>"
    And target codebase at "<codebase_path>"

    | Aspect | Detail |
    | Intent | <1-2 sentence intent> |
    | Labels | <comma-separated labels> |
    | Assignees | <comma-separated assignees> |
    | Total Tasks | <N> |

  Scenario: task-1 — <Task Name>
    Given task type is "<task_type>"
    And estimated complexity is "<low|medium|high>"
    And this task has no dependencies

    | Aspect | Detail |
    | Description | <full description of what to implement> |
    | Target Files | <comma-separated file paths> |
    | Acceptance Criteria | <criteria 1>; <criteria 2> |
    | Context | <relevant code context, key types, function signatures> |
    | Existing Tests | <paths to existing test files, or "none"> |
    | Existing Stories | <paths to existing story files, or "none"> |
    | Module Patterns | <brief note on how similar code is written in this module> |

  Scenario: task-2 — <Task Name>
    Given task type is "<task_type>"
    And estimated complexity is "<low|medium|high>"
    And this task depends on "task-1"

    | Aspect | Detail |
    | ... | ... |

  Scenario: task-N — <Task Name>
    ...
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
4. **DO** include enough context in each Scenario for a task-implementer to start without asking questions.
5. **DO** respect the 3-layer architecture: Service → Store → Component ordering.
6. **DO** identify existing tests and stories so implementer knows what to update.
7. **DO** note module patterns (how similar code is written nearby) for consistency.
8. Return the Gherkin Feature as your **final message** to the orchestrator.

---

## Job Context Awareness

When dispatched by `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
JOBS_ROOT:    .metaproject/jobs
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If `CONTEXT_PATH` is provided and the file exists, read it during Phase 2 (ANALYZE) to:
- Understand existing project conventions and patterns
- Identify relevant library documentation and best practices
- Avoid duplicating research already captured in the context document
- Use the context to improve the quality of task decomposition (e.g., better target_files, richer module_patterns)

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.

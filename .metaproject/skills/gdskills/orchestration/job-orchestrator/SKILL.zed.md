---
name: job-orchestrator
description: "Use when a GitHub issue or complex intent needs to be analyzed, planned, and implemented end-to-end with sub-agents."
triggers:
  - "Implement issue"
  - "Issue to PR"
  - "Orchestrate"
  - "Run pipeline"
  - "Analyze and implement"
  - "Full implementation"
  - "Full review"
  - "Полное ревью"
  - "Review my code"
  - "Analyze branch"
  - "Review via orchestrator"
  - "Orchestrated review"
  - "Auto-implement"
  - "Auto-implement issue"
  - "Orchestrate issue"
  - "Run issue pipeline"
  - "Full issue implementation"
metadata:
  author: "MrCipherSmith"
  version: "3.2.0"
  category: "orchestration"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely.
This skill is for orchestrators and interactive session-level routing only.
Proceed directly with your assigned task.
</SUBAGENT-STOP>

# Job Orchestrator

## Purpose

Dynamic orchestrator that builds execution plans based on user intent. Unlike a fixed pipeline, the orchestrator adapts its workflow to what the user actually needs — from "just analyze this issue" to "implement, review, and create a PR". It dispatches sub-agents (`issue-analyzer`, `context-collector`, `task-implementer`, review skills) and persists all work via `job-documenter`.

**Key design principle** (from Anthropic's "Building Effective Agents"):
> "The key difference from parallelization is its flexibility — subtasks aren't pre-defined, but determined by the orchestrator based on the specific input."

**Input:** User request (issue URL, analysis request, implementation request, etc.)
**Output:** Executed plan + persistent job documentation in `.metaproject/jobs/<job-name>/` + optional PR

## When to Use

- Implementing a complete GitHub issue from start to finish
- Analyzing an issue and proposing a solution before implementing
- Running any multi-step orchestrated workflow
- Running a comprehensive code review with persistent documentation
- When the AGENTS.md routing rule (Step 1.5) determines the user wants orchestrated execution and the user confirms
- User says "implement issue #N", "analyze issue #N", provides an issue URL, or asks for orchestrated work
- User says "full review", "полное ревью", or any request that implies orchestration

## Architecture: 4 Dynamic Phases

```
Phase 0: CONTEXT COLLECTION  →  Gather info, determine intent
Phase 1: PLAN BUILDING       →  Build dynamic plan, init job docs
Phase 2: EXECUTION           →  Execute plan steps, document each result
Phase 3: COMPLETION          →  Final report, optional PR, tell user where docs are
```

---

## Phase 0: CONTEXT COLLECTION

### 0.0 State Resumption Check

Before asking any questions, check if an interrupted job exists:
1. Look in `$JOBS_ROOT` for any directory containing an incomplete `state.json`.
2. If found, ASK the user: "Found paused job '<job-name>'. Do you want to resume it or start a new orchestrated job?"
3. If resume → Parse `state.json`, restore `JOB_STATE`, and jump directly to the first uncompleted step in Phase 2.
4. If new → Proceed to 0.1.

### 0.1 Determine User Intent

Parse the user's request to identify the intent:

| User Says | Intent | Plan Type |
|-----------|--------|-----------|
| "Implement issue #N" / "Issue to PR" | `implement` | Full: analyze → branch → implement → review → fix → checks → PR |
| "Analyze issue #N" / "Study issue" | `analyze` | Analysis only: analyze → report. Then ask if user wants to implement. |
| "Review my code" / "Review branch" | `review` | Review only: review → report |
| "Analyze and implement" | `implement` | Same as implement |
| Custom request | `custom` | Run `interviewer` skill first, then build plan from output |

**Ambiguity detection:** If the request uses vague words ("improve", "fix", "refactor") with no issue number or specific file — trigger the **Interactive Approach Selection** below.

### 0.1.1 Interactive Approach Selection (for ambiguous requests)

When intent cannot be determined confidently, present options to the user:

```
I see several ways to approach this. Which fits best?

  A) 🔍 Analysis only — decompose into tasks, show plan, stop
  B) 🛠 Full implementation — analyze → implement → review → PR
  C) 📋 Analysis + brainstorm — explore approaches before committing
  D) 🔧 Review only — review current branch changes
  E) 📝 Custom — describe what you need, I'll build the plan

> pick a letter or describe your own approach
```

**Mapping:**
- A → `analyze` intent
- B → `implement` intent
- C → `analyze` intent + trigger `brainstorm` after analysis
- D → `review` intent
- E → `custom` intent → proceed to 0.1.5 (interviewer gate)

**Skip this step** when intent is clear (explicit issue number, "implement issue #N", "review my code").

### 0.1.5 Interviewer Gate (for `custom` and ambiguous requests)

For `custom` intent OR any ambiguous request, invoke the `interviewer` skill **before** collecting standard context. This replaces the generic "What do you need?" question with a structured critical interview.

**Invoke:**
```
Load skill: skills/interviewer/SKILL.md

INPUT:
  topic: <user's original request>
  goal: "job-orchestrator — build execution plan"
  context:
    codebase_summary: <git log --oneline -10 if available>
    existing_analysis: <any issue content already known>
```

**Map output:**
- `derived_context` → `INTENT_STATE.task_description`
- answers with `confidence: "certain"` → `INTENT_STATE.constraints`
- `blockers` → surface to user (if non-empty, do NOT proceed)

**Gate rule:**
- `ready_to_proceed: false` → STOP. Tell user what blockers remain.
- `ready_to_proceed: true` → continue to 0.2 with enriched context.

**Skip** for `implement`/`analyze` with an issue number — requirements are in the issue.

### 0.2 Collect Required Context

The orchestrator MUST collect all required context before proceeding:

**Always ask (mandatory):**

1. **What to do** — for `implement`/`analyze`: from issue. For `custom`: from interviewer output (0.1.5).

2. **Project directory** — NEVER assume. Always ask explicitly:
   ```
   Which project directory should I use?
   ○ Type the full absolute path to your project
   (No default — always ask, never assume.)
   ```

3. **Base branch** — auto-detect from repo:
   ```bash
   # Detect default branch
   git -C <project_dir> symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
   # Fallback: check for main, master, develop
   ```
   Present detected branch and ask to confirm. No hardcoded default.

**Intent-specific questions:**

| Intent | Additional Questions |
|--------|---------------------|
| `implement` | Create PR? (default: yes). Skip if user already stated. |
| `analyze` | None — always produced. After: ask if user wants to implement. |
| `review` | Which branch to review? (default: current branch) |
| `custom` | None — covered by interviewer in 0.1.5 |

4. **Job name** — auto-generate based on context, ask user to confirm:
   ```
   Job documentation folder:
   ○ issue-4141--pipeline-validation  (auto-generated, Recommended)
   ○ Type your own name
   ```
   
   **Naming patterns:**
   - Issue implementation: `issue-<N>--<slug>`
   - Issue analysis: `analysis--issue-<N>`
   - Code review: `review--<slug>`
   - Custom: `task--<slug>`

### 0.3 Interview for Implement Intent

For `implement` intent, dispatch `interview` skill after collecting context to clarify implementation-specific ambiguities (complements 0.1.5 which handles `custom` intent):

```
Dispatch interview skill with:
{
  "goal": <issue title>,
  "context": <collected context + issue body>,
  "domain": "implement",
  "caller": "job-orchestrator",
  "known_facts": [project_dir, base_branch, issue details],
  "max_questions": null
}
```

**When to run:** `implement` intent only (if `run_interview: true`, default).
**Skip for:** `analyze` (analysis reveals details), `review` (scoped by diff), `custom` (covered by 0.1.5).

**Output → Phase 1:** `INTERVIEW_RESULT` feeds into plan building — informs task decomposition and architecture.

**Brainstorm trigger:** If during interview the user answers "not sure" or the interview identifies an unresolved architectural question (high-impact decision with no clear answer), auto-trigger:
```
Dispatch brainstorm --quick with:
  topic: <the specific architectural question>
  context: <project stack + interview answers so far>
```
Present brainstorm result as enriched answer options, then continue interview.

**Skip if:** user says "just do it" / "skip questions", or `run_interview: false`.

### 0.3.1 Dependency Check

If the issue or interview reveals the task is primarily about updating dependencies:
```
IF issue title/body contains "update", "upgrade", "bump", "dependency", "CVE":
  Suggest: "This looks like a dependency update task. Use /dependency-update instead?"
  IF user confirms → delegate to dependency-update skill, skip orchestrator pipeline
```

### 0.4 Summarize and Confirm

Before proceeding, present a summary:

```
Ready to proceed:
  Intent:    implement
  Issue:     #4141 — Pipeline validation improvements
  Project:   /Users/.../<PROJECT>
  Base:      develop-2
  Create PR: yes
  Job name:  issue-4141--pipeline-validation

Proceed? (yes / adjust)
```

---

## Phase 1: PLAN BUILDING

### 1.1 Build Execution Plan

Based on intent, construct an ordered list of steps:

**For `implement` intent:**
```
PLAN:
  1.  { id: "analyze",        type: "analyze",   agent: "issue-analyzer",    depends: [] }
  2.  { id: "context",        type: "context",   agent: "context-collector", depends: ["analyze"] }
  3.  { id: "prepare",        type: "prepare",   agent: "orchestrator",      depends: ["context"] }
  4.  { id: "tests-creator",  type: "tests",     agent: "tests-creator",     depends: ["prepare"] }
  5.  { id: "implement",      type: "implement", agent: "task-implementer",  depends: ["tests-creator"] }
  6.  { id: "sanity-check",    type: "check",    agent: "orchestrator",    depends: ["implement"] }
  7.  { id: "verify",          type: "verify",   agent: "code-verifier",   depends: ["sanity-check"] }
  8.  { id: "review",          type: "review",   agent: "code-review",     depends: ["verify"] }
  9.  { id: "security",        type: "security", agent: "security-audit",  depends: ["implement"], conditional: true }
  10. { id: "fix",             type: "fix",      agent: "task-implementer", depends: ["review"], conditional: true }
  11. { id: "verify-post-fix", type: "verify",   agent: "code-verifier",   depends: ["fix"], conditional: true }
  12. { id: "perf-check",      type: "perf",     agent: "perf-check",      depends: ["verify"], conditional: true }
  13. { id: "report",          type: "report",   agent: "orchestrator",    depends: ["verify"] }
  14. { id: "pr",              type: "pr",       agent: "orchestrator",    depends: ["report"], conditional: true }
  15. { id: "deploy",          type: "deploy",   agent: "deploy",          depends: ["pr"], conditional: true }
```

**Conditional step triggers:**
- `sanity-check`: always runs — verifies ≥1 commit was made
- `tests-creator`: always runs — mandatory TDD step before every task-implementer wave
- `verify`: always runs — code-verifier is the mandatory quality gate after implementation
- `security`: diff touches auth/, api/, migrations, schema files, or `.env`
- `fix`: review or verify found CRITICAL/HIGH findings
- `verify-post-fix`: always runs after fix (confirms fix resolved the findings)
- `perf-check`: diff contains *.tsx, *.jsx, *.css, dist/, build/ files
- `security`: diff touches auth/, api/, migrations, schema files, or `.env`
- `fix`: review found CRITICAL/WARNING findings
- `perf-check`: diff contains *.tsx, *.jsx, *.css, dist/, build/ files
- `pr`: `create_pr: true`
- `deploy`: user answers "yes" to post-PR staging deploy prompt

Note: `security` runs in parallel with `review` (both depend on `implement` results, no overlap).

**For `analyze` intent:**
```
PLAN:
  1. { id: "analyze",   type: "analyze",  agent: "issue-analyzer",    depends: [] }
  2. { id: "context",   type: "context",  agent: "context-collector", depends: ["analyze"] }
  3. { id: "report",    type: "report",   agent: "orchestrator",      depends: ["context"] }
  4. { id: "proposal",  type: "proposal", agent: "orchestrator",      depends: ["report"] }
```
Step 4 (`proposal`) asks the user: "Want me to implement this? If yes, I'll extend the plan."

**For `review` intent:**
```
PLAN:
  1. { id: "context",  type: "context", agent: "context-collector", depends: [] }
  2. { id: "review",   type: "review",  agent: "reviewers",         depends: ["context"] }
  3. { id: "report",   type: "report",  agent: "orchestrator",      depends: ["review"] }
```

**For `custom` intent:**
Build plan dynamically. Each step must have: id, type, agent, dependencies.

### 1.2 Initialize Job Documentation

Dispatch `job-documenter` with `init` action:

```
Task({
  description: "Init job docs: <job-name>",
  subagent_type: "general",
  prompt: |
    You are the job-documenter agent.
    Load skill: skills/job-documenter/SKILL.md
    Follow rules: rules/core/jobs-documentation.mdc

    ACTION: init
    JOB_NAME: <job-name>
    JOBS_ROOT: <JOBS_ROOT>

    DATA:
      TITLE: <job title>
      DESCRIPTION: <description>
      INTENT: <intent>
      SOURCE: <issue URL or description>
      PROJECT: <project path>
      BRANCH: TBD
      BASE_BRANCH: <base branch>
      PLAN: <plan steps>

    Execute and return DOCUMENTER_RESULT.
})
```

**Validate response:** status must be `success`. If `error` → report to user, ask how to proceed.

### 1.3 Display Plan + Agent Approval

Show each step with its agent and status, then ask the user to approve or adjust:

```
Execution plan — <N> steps:

  Step 1   analyze          issue-analyzer              → issue #<N>
  Step 2   context          context-collector           → project context + test framework
  Step 3   prepare          orchestrator                → feature branch
  Step 4   tests-creator    tests-creator × <tasks>     → RED test stubs per task (MANDATORY)
  Step 5   implement        task-implementer × <tasks>  → <N> tasks make tests GREEN (wave-parallel)
  Step 6   sanity-check     orchestrator                → verify commits exist
  Step 7   verify           code-verifier               → lint + type-check + tests + imports (MANDATORY)
  Step 8   review           code-review × 4             → parallel agents
  Step 9   fix              task-implementer            → [conditional: CRITICAL/HIGH findings]
  Step 10  verify-post-fix  code-verifier               → [conditional: after fix]
  Step 11  report           orchestrator                → final summary
  Step 12  pr               orchestrator + gh CLI       → [conditional: create_pr=true]

Optional (not in plan — add if needed):
  + security-audit   auto-detect: auth/API/DB changes
  + perf-check       auto-detect: if frontend/bundle files changed
  + deploy           ask after PR: "Deploy to staging?"

Proceed? (yes / adjust: "skip fix", "add security-audit", "remove pr", etc.)
```

**If user adjusts:**
- Parse natural language: "skip fix" → mark `fix` step as disabled
- "add security-audit" → insert `{ id: "security-audit", agent: "security-audit", depends: ["review"] }` after review
- "remove pr" → set `create_pr: false`
- Re-display updated plan and ask again

**If `plan_approval: false`** (automation setting) → skip this display and proceed directly.

---

## Phase 2: EXECUTION

Execute each step in plan order, documenting results after each step.

### 2.1 General Execution Loop

```
FOR step in PLAN:
  IF step.conditional AND condition_not_met:
    SKIP step, mark as "skipped"
    CONTINUE

  2.1.1  Mark step as in-progress (update display)
  2.1.2  Execute step (see step-specific instructions below)
         **CRITICAL RESILIENCE**: If the sub-agent returns a malformed result or fails to follow formatting rules, run an explicit retry:
         "The previous output was malformed. Fix these errors: [errors] and try again." (Max 2 retries before counting as critical failure).
  2.1.3  Collect result
  2.1.4  Document result via job-documenter (add-document)
         (Also update job state `state.json`)
  2.1.5  Update job README via job-documenter (update-readme)
  2.1.6  Mark step as completed
  
  IF step failed critically:
    Ask user: "Step '<name>' failed. Continue with remaining steps or abort?"
    IF abort: skip to Phase 3 (COMPLETION) with status "aborted"
```

### 2.2 Step: ANALYZE

Dispatch `issue-analyzer` as a sub-agent.

**Prepare prompt:** Read `skills/issue-analyzer/orchestrator-prompt.md` (if it exists) and fill in:
- Issue URL or repo+number
- Codebase paths with roles
- Automation settings (skip_confirmation: true, search_depth: focused)

**Launch:**
```
Task({
  description: "Issue analysis: #<N>",
  subagent_type: "general",
  prompt: <constructed prompt>
})
```

**Parse result:** Extract JSON analysis object:
```
ANALYSIS_RESULT:
  issue_type:     from issue.type
  total_tasks:    from issue.total_tasks (= tasks.length)
  tasks: [{task_id, task_name, task_type, complexity, dependencies,
           description, target_files, acceptance_criteria, context,
           existing_tests, existing_stories, module_patterns}]
  dependency_order: from dependency_order array (already topologically sorted)
```

**Validate:** At least 1 task, no circular dependencies, all dependency references valid. Dependency_order array must contain all task_ids exactly once.

**Document:** Send to job-documenter:
```
ACTION: add-document
DATA:
  DOC_TYPE: analysis
  TARGET: both
  TITLE: Issue Analysis — #<N>
  CONTENT: <human-readable summary for man/, raw JSON for ai/>
  AGENT: issue-analyzer
  TASK: Analyze issue #<N>
```

**For `analyze` intent:** After documenting, present analysis to user. Ask:
```
Analysis complete. Found <N> tasks.
Want me to implement this? I'll create a feature branch and run the full pipeline.
○ Yes, implement
○ No, analysis is enough
```
If "Yes" → extend PLAN with context → prepare → implement → review → fix → checks → pr steps. Continue execution.
If "No" → skip to Phase 3 (COMPLETION).

### 2.3 Step: CONTEXT

Dispatch `context-collector` to build the unified context document.

**Prepare prompt:** Use the template from `skills/context-collector/SKILL.md`:

```
Task({
  description: "Collect context: <job-name>",
  subagent_type: "general",
  prompt: |
    You are the context-collector agent. Your task is to research and build
    a context document for the current job.

    Load the skill from: skills/context-collector/SKILL.md

    ACTION: collect
    JOB_NAME: <job-name>
    JOBS_ROOT: <JOBS_ROOT>
    PROJECT_DIR: <project_dir>

    DATA:
      TASK_DESCRIPTION: <from issue or user request>
      FOCUS_AREAS: <derived from analysis — affected areas, libraries>
      ANALYSIS_RESULT: <output from issue-analyzer, if available>
      KNOWN_LIBRARIES: <from package.json scan during analysis>

    Execute all phases and return a CONTEXT_RESULT block.
})
```

**Parse result:**
```
CONTEXT_RESULT:
  status:    success | error
  version:   <document version>
  summary:   <what context was collected>
```

**Validate:** status must be `success`. If `error` → log warning, continue (context is helpful but not blocking).

**After context is collected:** All subsequent sub-agents receive the **versioned** context path from state.json:
```
CONTEXT_LOCATION: <JOBS_ROOT>/<job-name>/ai/context_v<N>.md
```

**Context versioning:** Never overwrite `context.md` — save snapshots as `context_v1.md`, `context_v2.md`, etc.
- Version 1 is created during Step 2.3 (first collect)
- Subsequent versions increment on each update
- `state.json → context_doc.version` always points to the latest version
- Sub-agents always read the path from `state.json`, not a hardcoded filename

**Triggering context updates during execution:**

If during later steps (implement, review) a sub-agent reports missing context or a new library is discovered:

```
Task({
  description: "Update context: <job-name>",
  subagent_type: "general",
  prompt: |
    You are the context-collector agent. Update the existing context.

    Load the skill from: skills/context-collector/SKILL.md

    ACTION: update
    JOB_NAME: <job-name>
    JOBS_ROOT: <JOBS_ROOT>
    PROJECT_DIR: <project_dir>
    CONTEXT_VERSION: <current version + 1>  ← write to context_v<N+1>.md

    DATA:
      TASK_DESCRIPTION: <original task description>
      UPDATE_REASON: <why context needs updating>
      FOCUS_AREAS: <new areas to research>

    Execute update flow and return a CONTEXT_RESULT block.
})
```

### 2.4 Step: PREPARE

Create git worktree for feature branch.

> **CRITICAL**: Feature branches MUST be created via `git worktree add`.
> **NEVER** use `git checkout -b` or `git switch -c` — this switches the main working directory.
> The worktree is a **sibling directory** to the project directory.

**Determine branch name:**
```
Format: feature/<custom-slug>
Slug: descriptive, lowercase, alphanumeric+hyphens, from issue title/feature
Examples: feature/pipeline-validation, feature/mirror-step-source-column
```

**Create worktree:**
```bash
# Fetch latest base branch
git -C <project_dir> fetch origin <base_branch>

# Create worktree as SIBLING directory
git -C <project_dir> worktree add ../<branch-slug> -b feature/<branch-slug> origin/<base_branch>

# Example:
# Project dir: /Users/user/projects/<PROJECT>
# git -C ... worktree add ../pipeline-validation -b feature/pipeline-validation origin/develop-2
# Result worktree: /Users/user/projects/pipeline-validation
# Result branch:   feature/pipeline-validation

# Auto-detect package manager and install dependencies
if [ -f <worktree_path>/bun.lockb ]; then
  PM="bun"; RUNNER="bun run"; bun install --cwd <worktree_path>
elif [ -f <worktree_path>/pnpm-lock.yaml ]; then
  PM="pnpm"; RUNNER="pnpm run"; pnpm install --prefix <worktree_path>
elif [ -f <worktree_path>/yarn.lock ]; then
  PM="yarn"; RUNNER="yarn"; yarn --cwd <worktree_path>
elif [ -f <worktree_path>/package-lock.json ]; then
  PM="npm"; RUNNER="npm run"; npm install --prefix <worktree_path>
elif [ -f <worktree_path>/requirements.txt ]; then
  PM="python"; RUNNER=""; pip install -r <worktree_path>/requirements.txt
elif [ -f <worktree_path>/go.mod ]; then
  PM="go"; RUNNER=""; (cd <worktree_path> && go mod download)
fi
```

> **IMPORTANT**: After creating the worktree, ALL subsequent operations (implementation, review, lint, test, git) MUST run in the **worktree directory**, NOT in the original project directory.

**Record state:**
```
BRANCH_STATE:
  name: feature/<branch-slug>
  base: <base_branch>
  worktree_path: <absolute path to worktree>
  project_dir: <original project directory — DO NOT modify>
  created_from_commit: <commit hash>
  package_manager: <PM>
  run_command: <RUNNER>
```

> **Store `package_manager` and `run_command` in JOB_STATE** — all subsequent steps use these instead of hardcoded `npm`.

**Document:** Update README via job-documenter (update-readme) with branch info.

### 2.4.1 Step: TESTS-CREATOR + IMPLEMENT — Wave Isolation

**IRON LAW: tests-creator MUST run before task-implementer for every task. No exceptions.**

**CONTEXT BUDGET RULE: Each wave runs as a single isolated sub-agent. The orchestrator never dispatches task-implementers or tests-creator directly. This keeps the orchestrator context bounded to compact wave summaries regardless of job size.**

---

#### Why wave isolation

When the orchestrator dispatches task-implementers directly, each sub-agent result (STATUS text + verification output) accumulates in the orchestrator's context. After 3–4 waves this context can reach 100k+ tokens, causing the session to freeze during context reload. Wave isolation prevents this: each wave sub-agent runs in its own context and returns only a compact summary.

---

#### Execution pattern

```
WAVES = topological_sort_into_waves(dependency_order, task_dependencies)

FOR wave_index, wave_tasks in enumerate(WAVES):
  Dispatch SINGLE Agent("wave-executor") with all tasks in this wave.
  
  Receive compact WAVE_RESULT:
    STATUS: WAVE_DONE | WAVE_PARTIAL | WAVE_FAILED
    Wave: <index>
    Commits: [hash msg, hash msg, ...]
    Tests: <N passed, M failed>
    Tasks: task-1 ✅, task-2 ✅
    Result files: <JOBS_ROOT>/<job-name>/results/task-*.json
  
  Decision:
    WAVE_DONE    → continue to next wave
    WAVE_PARTIAL → log warnings, continue (read result files for details)
    WAVE_FAILED  → STOP, read result files for failed tasks, ask user
```

#### Wave executor prompt template

```
Task({
  description: "Wave <N>: implement tasks <task_ids>",
  subagent_type: "general",
  prompt: |
    You are a wave executor. Implement all tasks in this wave, then return a compact summary.
    
    ## Wave
    Wave <N> of <total>
    
    ## Tasks
    <JSON array of task objects for this wave>
    
    ## Workspace
    - worktree_path: <absolute path>
    - branch: <branch name>
    - package_manager: <pm>
    - run_command: <runner>
    - issue_number: <N>
    - job_name: <job-name>
    - context_path: <path to context_vN.md>
    
    ## Instructions
    
    **Step A — tests-creator (MANDATORY, run first):**
    For each task in this wave, dispatch tests-creator in parallel:
      Load skill: skills/tests-creator/SKILL.md
      Pass: task object, workspace, context_path
      Collect: TEST_SPECS[task_id] from each response
    Wait for ALL tests-creator agents to finish before Step B.
    
    **Step B — task-implementer (after all test stubs committed):**
    For each task in this wave, dispatch task-implementer in parallel (if no file overlap; sequential otherwise):
      Load skill: skills/task-implementer/SKILL.md
      Pass: task object WITH test_case_specs: TEST_SPECS[task_id], workspace, job_name, context_path
    Wait for ALL task-implementer agents to finish.
    
    **Parallel safety check:** Before Step B, verify no two tasks share target_files.
    If overlap → run sequentially within this wave.
    
    ## Required response format (compact — no inline JSON)
    
    STATUS: WAVE_DONE
    Wave: <N>
    Commits: [abc1234 feat(x): ..., def5678 feat(y): ...]
    Tests: <N passed, M failed>
    Tasks: task-1 ✅, task-2 ✅
    Result files: <JOBS_ROOT>/<job-name>/results/task-1.json, task-2.json
    
    Use WAVE_PARTIAL if any task is DONE_WITH_CONCERNS.
    Use WAVE_FAILED if any task is BLOCKED or failed.
    Do NOT include full task output inline — write details to result files.
})
```

**After all waves, document:**
```
ACTION: add-document
DATA:
  DOC_TYPE: implementation-report
  TARGET: both
  TITLE: Implementation Report
  CONTENT: <summary of all waves, commits, test totals>
  AGENT: wave-executor
  TASK: Implementation phase
```

### 2.5.1 Post-Implementation Checkpoint

After all waves complete, check if tests were created. If not, offer `test-gen`:

```
# Derive all modified files from wave summaries and result files
ALL_FILES = collect from WAVE_RESULTS (read result files for details if needed)

IF no test files in ALL_FILES:
  Auto-trigger test-gen for new/modified source files
  (skip test files, config files, types-only files)
```

Then present the implementation summary to user:

```
Implementation complete:
  - <N>/<M> tasks ✅
  - <X> files modified, <Y> files created
  - Tests: <created by implementer | auto-generated by test-gen | none>

What's next?
  A) 🔍 Review → fix → PR (standard pipeline)
  B) 👀 Show me the diff first — I'll review manually
  C) 🚀 Skip review, go straight to PR
  D) ⏹ Stop here — I'll continue manually
```

**Mapping:**
- A → continue to REVIEW step (default if no response in 60s)
- B → run `git diff <merge_base>..HEAD --stat` and `git diff <merge_base>..HEAD`, then re-ask
- C → skip REVIEW and FIX steps, go to CHECKS → PR
- D → skip to Phase 3 (COMPLETION) with status "paused"

### 2.5.5 Step: IMPLEMENT SANITY CHECK

Lightweight verification after all waves complete, **before** launching review.
This catches the case where a wave sub-agent claims WAVE_DONE but made no actual git changes.

```bash
# Run in worktree directory
git diff --stat <merge_base>..HEAD
git log <merge_base>..HEAD --oneline
```

**Gate conditions:**

| Check | Pass | Fail action |
|-------|------|-------------|
| At least 1 commit exists | ≥1 commit | `retryable` — re-dispatch the failed wave-executor with: "No commits were made. Implement the changes and commit them." |
| At least 1 file modified | ≥1 file changed | Same as above |
| Claimed files actually modified | All files in wave result match diff | Log discrepancy as WARNING, continue |

**If retry also produces no commits** → classify as `terminal`, ABORT with:
```
"wave-executor returned WAVE_DONE twice but made no git changes.
Please implement manually and re-run from the review step."
```

**Record:**
```
SANITY_CHECK:
  commits: <count>
  files_changed: <count>
  lines_added: <N>
  lines_removed: <N>
  verified: true | false
```

---

### 2.6 Step: REVIEW

#### 2.6.0 Review Strategy Selection

If the user didn't specify a review approach, offer options:

```
How should I review the implementation?

  A) 🚀 Quick (code-review 4-agent parallel) — ~30 sec
  B) 📋 Thorough (individual reviewers: ai + boss + style + mobx) — ~2 min
  C) 🔒 Security-focused (code-review + security-audit) — ~1 min
  D) ⏭ Skip review entirely

> pick a letter (default: A)
```

Then ask which optional convention reviewers to include when local convention docs or matching
paths are present:

```
Which project-convention reviewers should I include?

  A) Include all detected convention reviewers (recommended)
  B) Choose individually
  C) Skip convention reviewers

Detected reviewers:
  - review-frontend-conventions: frontend files / stories / local frontend guide
  - review-testing-practices: tests, stories, MSW, or e2e files
  - review-core-boundaries: shared core/infrastructure files
  - review-flow-graph: shared graph/flow abstraction files
```

Only show detected reviewers. If the user chooses B, ask for the exact skill names to include or
exclude, then persist the choice in job state as `convention_reviewers`.

**Auto-select** (skip this question) when:
- `review_mode` is explicitly set in automation settings → use that
- `convention_reviewers` is explicitly set in automation settings → use that for optional convention reviewers
- User already chose at Post-Implementation Checkpoint (2.5.1 option A) → use default (A)
- Time pressure (total_job_timeout close) → use A (fastest)

#### 2.6.1 Execute Review

Dispatch review skills on the whole branch. **Launch all reviewers in parallel** for speed.

**Strategy A — `code-review` (4-agent parallel):**

Dispatches 4 agents in parallel (correctness, security, performance, style) and produces a unified severity report.

```
Launch code-review skill with:
  scope: git diff <merge_base>..HEAD
  output: unified report with CRITICAL/HIGH/MEDIUM/LOW findings
```

**Fallback — individual reviewers (if code-review unavailable or user prefers):**

Determine and **dispatch all reviewers simultaneously** (not sequentially):

| Reviewer | Condition | Launch |
|----------|-----------|--------|
| `code-ai-review` | Always | Parallel |
| `code-boss-review` | Always | Parallel |
| `code-style-review` | Always | Parallel |
| `code-mobx-store-review` | Only if `*.store.ts` modified | Parallel |
| `review-frontend-conventions` | If selected and frontend files/local frontend docs match | Parallel |
| `review-testing-practices` | If selected and tests/stories/e2e files match | Parallel |
| `review-core-boundaries` | If selected and shared core files match | Parallel |
| `review-flow-graph` | If selected and shared graph/flow files match | Parallel |

```
# Launch ALL applicable reviewers in a SINGLE turn (parallel):
Agent 1: code-ai-review (correctness, security)
Agent 2: code-boss-review (architecture, logic)
Agent 3: code-style-review (naming, patterns)
Agent 4: code-mobx-store-review (if applicable)
Agent 5+: selected convention reviewers (if applicable)

# Wait for all to complete, then merge results
```

**Review-orchestrator mode (preferred when available):**

If `review-orchestrator` exists in the skill catalog, dispatch it with the selected review flags
instead of manually launching individual reviewers. Pass selected convention reviewer flags:
`--project-conventions`, `--frontend-conventions`, `--testing-practices`, `--core-boundaries`,
and/or `--flow-graph`.

Pass review orchestration controls:
```
context_mode: <review_context_mode automation setting; default "light", ask "full" for high-risk PRs>
token_budget: <review_token_budget automation setting or computed scope budget>
model_strategy: <review_model_strategy automation setting; default "current">
output: unified report with findings, review_context, token_policy, and model metadata
```

**Collect and merge findings:**
```
REVIEW_FINDINGS: [{
  reviewer: "<skill-name>",
  findings: [{ file, line, severity: CRITICAL|WARNING|INFO, message }]
}]
```

**Strategy C — Security-focused:**

Run `code-review` (4-agent) AND `security-audit` in parallel:
```
Agent group 1: code-review (correctness, security, performance, style)
Agent group 2: security-audit (dependency vulnerabilities, secrets scan, OWASP patterns)
```
Merge findings from both into unified `REVIEW_FINDINGS`.

**Deduplicate:** If multiple reviewers flag the same file:line, merge into a single finding with the highest severity.

**Classify:**
```
NEEDS_FIX = count(CRITICAL) > 0 OR count(WARNING) > 0
```

**Document:**
```
ACTION: add-document
DATA:
  DOC_TYPE: review
  TARGET: both
  TITLE: Code Review Results
  CONTENT: <findings summary for man/, structured findings for ai/>
```

#### 2.6.2 PR Review Report Publication

If this job is reviewing an existing GitHub PR, or if a PR number/URL was resolved before the review step, ask whether to publish the consolidated review report after review findings are documented and before fix decisions. This gives the user a chance to record the current review state before any automatic fix loop changes it.

Ask unless automation settings explicitly set `publish_pr_review_report`:

```text
Publish the review report to the PR?

  A) Concise PR comment only
  B) Concise PR comment + detailed AI markdown artifact (recommended for follow-up fixes)
  C) Do not publish

> pick a letter (default: C)
```

**Rules:**
- The PR comment and AI artifact must be written in English only, regardless of the chat language or reviewer output language.
- Default is C. Never publish to a PR without explicit user confirmation or `publish_pr_review_report: comment`, `publish_pr_review_report: comment-and-ai-artifact`, or legacy `publish_pr_review_report: true`.
- If the job has review findings but no PR number yet, store `pending_pr_review_report_comment` and `pending_review_ai_artifact` in job state. If the later PR step creates a PR, ask the same question after PR creation.
- If the user chooses A, delegate concise comment formatting to `review-orchestrator`'s PR Review Report Publication contract when available.
- If the user chooses B, delegate concise comment formatting and generate `.metaproject/jobs/<job-name>/ai/review-ai-report.md` using `review-orchestrator`'s Detailed AI Markdown Artifact contract.
- If the user chooses B, the PR comment `Meta` section must include both an `AI artifact` link/path and an `AI artifact description` row explaining in human-readable language that the markdown file contains detailed findings, fix guidance, patch guidance, regression coverage, validation plan, and follow-up agent context.
- If using legacy reviewers, normalize findings into the same concise PR comment and AI artifact structures before posting.
- Record the final decision in job state as `publication_plan.mode`: `comment`, `comment-and-ai-artifact`, or `none`.

**Automation values:**
- `publish_pr_review_report: ask` -> ask the question above.
- `publish_pr_review_report: comment` or legacy `true` -> publish the concise PR comment only.
- `publish_pr_review_report: comment-and-ai-artifact` -> publish the concise PR comment and create/link the detailed AI markdown artifact.
- `publish_pr_review_report: none` or legacy `false` -> do not publish.

#### 2.6.3 Post-Review Checkpoint

After review completes, present findings and ask user:

```
Review complete:
  🔴 <N> CRITICAL  🟠 <M> HIGH  🟡 <K> MEDIUM  🔵 <L> LOW

  A) 🔧 Auto-fix and continue (fix CRITICAL + HIGH, skip LOW)
  B) 📋 Show all findings — I'll decide what to fix
  C) ⏭ Skip fixes, proceed to PR as-is
  D) ⏹ Stop — I'll fix manually
```

**Mapping:**
- A → proceed to FIX step (default if CRITICAL > 0)
- B → display all findings grouped by file, then re-ask A/C/D
- C → skip FIX step, go to CHECKS (only if 0 CRITICAL — refuse if CRITICAL > 0)
- D → skip to Phase 3 (COMPLETION) with status "paused"

**Auto-proceed** (skip this question) when:
- 0 findings → skip directly to CHECKS
- Only INFO findings → skip FIX, go to CHECKS
- `auto_create_pr: true` → auto-select A

### 2.7 Step: FIX (conditional)

Only runs if NEEDS_FIX is true. Default max: **3 iterations** (`max_review_iterations`).

```
UNRESOLVED_FINDINGS = all CRITICAL + WARNING findings from step 2.6

FOR iteration in [1, 2, 3]:
  IF NOT NEEDS_FIX: BREAK

  1. Group UNRESOLVED_FINDINGS by file
  2. Construct fix prompt — MUST include unresolved findings from previous attempt:

     task_type: "fix"
     findings: <UNRESOLVED_FINDINGS>
     iteration: <N>
     previously_unresolved: <findings that were in UNRESOLVED_FINDINGS last iteration but still present>
         → Prefix: "These specific findings were NOT fixed in iteration <N-1>: [list]"

  3. Launch task-implementer with fix prompt
  4. Run sanity-check (step 2.5.5 logic) — verify commits were made
  5. Re-run reviewers (step 2.6) — parallel dispatch
  6. Recompute NEEDS_FIX from new findings
  7. Update UNRESOLVED_FINDINGS = remaining CRITICAL + WARNING

IF still NEEDS_FIX after max iterations:
  Log "Unresolved after <N> iterations" with finding list → continue to checks
```

**Fix prompt escalation pattern:**
- Iteration 1: "Fix these findings: [list]"
- Iteration 2: "These findings were NOT fixed in iteration 1: [subset]. Fix them now."
- Iteration 3: "FINAL attempt. These findings remain after 2 fix passes: [subset]. This is the last fix iteration." 

### 2.8 Step: VERIFY (code-verifier)

Dispatch `code-verifier` as a sub-agent. This replaces the orchestrator-internal "checks" step.

```
Task({
  description: "Quality gate: <job-name>",
  subagent_type: "general",
  prompt: |
    You are code-verifier. Load skill: skills/code-verifier/SKILL.md

    codebase_path: <worktree_path>
    base_branch:   <base_branch>
    scope:         changed
    
    Run all 4 phases and return VERIFICATION_RESULT.
})
```

**Handle result:**
```
IF VERIFICATION_RESULT.gate == "PASS" or "PASS_WITH_WARNINGS":
  → Proceed to review
  → Log findings as informational in job docs

IF VERIFICATION_RESULT.gate == "FAIL":
  → Extract CRITICAL/HIGH findings
  → Check if fix step is already scheduled
    - If not → add fix step to plan (dispatch task-implementer in fix mode)
    - If fix already ran 2× → escalate to user, skip to report
```

**Document result:**
```
ACTION: add-document
DATA:
  DOC_TYPE: verification-report
  TARGET: both
  TITLE: Verification Report — <gate status>
  CONTENT: <VERIFICATION_RESULT formatted>
  AGENT: code-verifier
```

### 2.8.1 Step: VERIFY-POST-FIX (code-verifier, conditional)

After fix iterations, dispatch `code-verifier` again with identical parameters.

```
IF fix ran:
  Dispatch code-verifier (same params as step 2.8)
  IF gate still FAIL:
    Log "Verification failed after fix" → skip to report with warning
  IF gate PASS:
    Proceed to report
```

### 2.8.1 Step: PERF-CHECK (optional)

Auto-trigger `perf-check` when frontend/bundle files were modified:

```
IF any modified file matches: *.tsx, *.jsx, *.css, *.scss, webpack.*, vite.*, next.config.*
  AND project has build output (dist/, build/, .next/)
  THEN:
    Dispatch perf-check --bundle
    Add findings to report (informational, not blocking)
```

Skip if no frontend files changed or no build output exists. Results are advisory — they don't block the PR.

### 2.9 Step: REPORT

Aggregate all information into a human-readable summary.

**Report structure:**
```markdown
# Job Report: <Title>

## Summary
- **Intent:** <implement / analyze / review>
- **Source:** <issue URL or description>
- **Branch:** `<branch_name>`
- **Tasks:** <completed>/<total> completed
- **Review Iterations:** <N>
- **Final Status:** <READY FOR PR | HAS WARNINGS | HAS ISSUES | ANALYSIS ONLY>

## Analysis
<analysis summary>

## Tasks
### task-1: <Name>
- **Status:** success
- **Files:** <list>
- **Commits:** <hashes>

## Review Results
### code-ai-review
- CRITICAL: <N>, WARNING: <N>, INFO: <N>
### code-boss-review
- ...

## Unresolved Issues
- [ ] <file>:<line> — <message> (from <reviewer>)

## Final Checks
- Lint: PASS
- Type Check: PASS
- Tests: 42 passed, 0 failed

## Changes Summary
### Files Modified (<N>)
- `src/...`

### Files Created (<N>)
- `src/...`

### Commits (<N>)
- `abc1234` feat(pipelines): add validation
```

### 2.10 Step: PR (conditional)

Only runs if `create_pr` is true and intent is `implement`.

**Dispatch `pr-issue-documenter` to generate the PR description:**

Pass the following context to `pr-issue-documenter`:
```
ACTION: generate-pr-description
JOB_NAME: <job-name>
BRANCH: <feature_branch>
BASE: <base_branch>
ISSUE_NUMBER: <issue_number if available>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

`pr-issue-documenter` will analyze the branch diff and produce a structured PR description (Summary + Changes by area + Key Files table). Use its output as the `body` for the PR.

**Enrich PR with changelog entry:**

Dispatch `changelog` skill to generate a changelog snippet for this branch:
```
changelog <base_branch>..HEAD --format compact
```
Append the changelog snippet to the PR body under a `## Changelog` section.

**Present to user:**
```
Implementation complete. Draft PR proposal:

Title: <type>(#<issue>): <description>
Base: <base> ← <head>

<pr-issue-documenter output>

## Changelog
<changelog snippet>

Create this draft PR? (yes/no/edit)
```

If user says "edit" → show the full body, let them modify before creating.

**If confirmed:**
```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)" --base <base_branch> --head <feature_branch> --draft
```

---

## Phase 3: COMPLETION

### 3.1 Finalize Job Documentation

Dispatch job-documenter with `finalize` action:

```
ACTION: finalize
DATA:
  FINAL_CONTENT: <full report markdown>
  FINAL_STATUS: completed | aborted
  SUMMARY: <1-3 sentence summary>
```

**Validate response:** status must be `success`.

### 3.2 Present Results

Tell user:
1. What was accomplished (summary)
2. Where documentation is stored: `.metaproject/jobs/<job-name>/`
3. PR URL (if created)
4. Metrics summary (time, tokens)
5. Any unresolved issues

```
✅ Job completed successfully.

  Documentation: <JOBS_ROOT>/<job-name>/
  Branch:        feature/<slug> (worktree: <path>)
  PR:            <URL or "not created">
  Metrics:       <total time>, <total tokens>
  
  See .metaproject/jobs/<job-name>/README.md for the full job index.
```

### 3.3 Post-Completion Options

After presenting results, offer next steps:

```
What would you like to do next?

  A) ✅ Done — nothing else needed
  B) 🚀 Deploy to staging — run /deploy staging
  C) 🔄 Start another job
  D) 📝 Update CLAUDE.md with session learnings
```

- B → dispatch `deploy` skill with `staging` environment
- D → dispatch `claude-md-management` skill

**Auto-skip** if the job was `analyze` or `review` intent (no deploy makes sense).

---

## Plan Extension (Dynamic Planning)

When the orchestrator starts with an `analyze` intent and the user then says "yes, implement":

1. **Keep existing completed steps** (analyze, context, report are already done)
2. **Extend plan** with new steps: prepare → implement → review → fix → checks → report → pr
3. **Update job documentation** via job-documenter (update-readme with new plan)
4. **Continue execution** from the first new step

This is the core of dynamic planning — the plan grows based on user decisions.

---

## State Management

The orchestrator maintains state throughout all phases:

```
JOB_STATE:
  phase: CONTEXT | PLAN | EXECUTION | COMPLETION
  intent: implement | analyze | review | custom
  create_pr: <bool>
  job_name: <string>
  
  context:
    issue: { number, title, url, type }
    project_dir: <path>
    base_branch: <string>
  
  branch:
    name: <string>
    worktree_path: <path>
    merge_base: <commit hash>
  
  plan:
    steps: [{ id, type, agent, depends, status: pending|in_progress|completed|skipped|failed, prompt_chars: <int>, prompt_hash: <sha256 first 8 chars> }]
    current_step: <step_id>
  
  analysis:
    total_tasks: <N>
    tasks: [<task objects>]
    dependency_order: [<task_ids>]
  
  context_doc:
    path: <JOBS_ROOT>/<job-name>/ai/context.md
    version: <current version>
    status: collected | updated | not-collected
  
  implementation:
    task_results: {<task_id>: <result>}
    all_commits: [<hash>]
    all_files: [<path>]
  
  review:
    iteration: <N>
    findings: [<findings>]
    needs_fix: <bool>
    unresolved: [<findings>]
  
  final_checks:
    lint: <result>
    type_check: <result>
    tests: <result>
  
  documentation:
    job_path: <JOBS_ROOT>/<job-name>
    documents_created: [<paths>]
```

---

## state.json Specification

The orchestrator persists JOB_STATE to `.metaproject/jobs/<job-name>/state.json` for job resumption.

**Location:** `.metaproject/jobs/<JOB_NAME>/state.json`

**Schema reference:** `skills/job-orchestrator/state.schema.json`

**When to create:** During Phase 1.2 (Initialize Job Documentation) — write initial state after job docs are initialized.

**When to update:** After every step completion in Phase 2 (EXECUTION) — update `plan.steps[i].status`, `plan.steps[i].prompt` (store the prompt used), and `plan.current_step`.

**How to write state.json:**
```bash
# Write state (orchestrator handles this directly, not via job-documenter)
cat > .metaproject/jobs/<JOB_NAME>/state.json << 'EOF'
{
  "phase": "EXECUTION",
  "intent": "<intent>",
  "job_name": "<job-name>",
  ...
}
EOF
```

**Job resumption (Phase 0.0):** If `state.json` exists and `phase` is not `COMPLETION`, offer to resume. Parse the file, restore JOB_STATE, jump to the first step with `status: "pending"` or `status: "in_progress"`.

---

## Interpreting Subagent Results

**Rule:** `rules/core/subagent-status-protocol.md`

All subagents dispatched by this orchestrator MUST begin their final response with `STATUS: <STATUS>`. The orchestrator reads this line first and routes accordingly.

### Iron Law

**IF A SUBAGENT DOES NOT START WITH `STATUS:`, TREAT IT AS `NEEDS_CONTEXT` AND REQUEST A PROPERLY FORMATTED RESPONSE**

Do not attempt to infer status from prose. Do not trust a response that "looks fine" but lacks the status line. Run one explicit retry: "Your response did not start with STATUS: <STATUS>. Please reformat using the subagent status protocol (rules/core/subagent-status-protocol.md) and resend your result."

### How to handle each status

**`STATUS: DONE`**
- Accept result.
- Extract structured payload (JSON result, files changed, commits, verification results).
- Mark step as completed in JOB_STATE.
- Continue to next step in the plan.

**`STATUS: DONE_WITH_CONCERNS`**
- Accept result as complete.
- Read the `## Concerns for orchestrator` section carefully.
- Decide: (a) log concern and continue, (b) surface concern to user at next checkpoint, or (c) re-dispatch with adjusted scope if the concern affects correctness.
- Do NOT silently discard concerns. Record them in JOB_STATE and include in the final report.
- Mark step as completed.

**`STATUS: BLOCKED`**
- Do NOT proceed to any step that depends on this task.
- Read `## Reason` and `## What I need from orchestrator`.
- Resolve the blocker: provide the missing file, make the decision, fix the dependency, or escalate to the user.
- Re-dispatch the subagent with the resolved context.
- If the blocker cannot be resolved (e.g., missing information requires user input) → surface to user: "Task <id> is blocked: <reason>. What would you like to do?"

**`STATUS: NEEDS_CONTEXT`**
- Do NOT mark step as failed.
- Read `## Missing information` and `## Where it might be found`.
- Locate the missing information (check job context document, issue body, package.json, codebase).
- Re-dispatch the subagent with the enriched task input.
- If the information is not available anywhere → escalate to user with the specific question.

### Red Flag

**"The subagent didn't use the status protocol, but the result looks fine"**

Do not accept this. A subagent that ignores the status protocol is unpredictable — its next failure may not look fine. Enforce the protocol on every response. Run the retry. If the subagent still does not comply after the retry, log it as a critical failure and ask the user how to proceed.

---

## Constructing Subagent Context

**Rule:** `rules/core/subagent-context-construction.md`

Every prompt dispatched to a subagent must be **explicitly constructed** by the orchestrator. Subagents do not inherit session context, job state, or prior agent output — they only know what the orchestrator tells them.

### Template dispatch block

Use this structure for every subagent dispatch:

```
Task({
  description: "<one-line summary for logs>",
  subagent_type: "general",
  prompt: |
    ## Task
    <Exactly what to do — no ambiguity>

    ## Acceptance Criteria
    - <criterion 1>
    - <criterion 2>

    ## Context
    <Only what is relevant for THIS task — decisions, constraints, background>

    ## Files to read
    - <absolute/path/to/file1.ts>
    - <absolute/path/to/file2.ts>

    ## Constraints
    - Do NOT modify <file or pattern>
    - <other hard stops>
})
```

### Minimality principle

Pass only what the subagent needs for this specific task. Do not dump job state, full analysis JSON, or conversation history. Extraneous context fills the subagent's context window with noise and increases hallucination risk.

Each subagent type gets scoped context:
- `issue-analyzer` — issue data + codebase paths only
- `context-collector` — focus areas + analysis summary (not full analysis JSON)
- `task-implementer` — its specific task object + `CONTEXT_PATH` (not other tasks' data)
- Reviewers — diff range + file list (not implementation details)

### Red Flag

**"The subagent can read the job state.json if it needs more context"**

→ Iron Law: **Orchestrator constructs context. Subagents receive, not retrieve.**

The subagent must not fetch orchestrator state independently. If the subagent needs information, the orchestrator puts it in the dispatch prompt. A subagent reading `state.json` on its own is a sign the orchestrator dispatch was incomplete.

---

## Automation Settings

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `skip_confirmation` | `true` | true/false | Skip confirmation for sub-agents |
| `base_branch` | auto-detect | any | Base branch (auto-detect from repo default, or ask user) |
| `max_review_iterations` | `3` | 1-5 | Max review → fix iterations |
| `create_pr` | `true` | true/false | Whether to propose PR at the end |
| `auto_create_pr` | `false` | true/false | Auto-create PR without asking |
| `review_mode` | `"code-review"` | `"code-review"` / `"individual"` | Use 4-agent parallel or individual reviewers |
| `reviewers` | `["code-ai-review", "code-boss-review", "code-style-review"]` | skill names | Individual reviewers (when review_mode=individual) |
| `conditional_reviewers` | `{"code-mobx-store-review": "*.store.ts"}` | skill→pattern | Conditional reviewers |
| `convention_reviewers` | `"ask"` | `"ask"` / `"all"` / `"none"` / skill names | Optional convention reviewers to include in review |
| `run_final_checks` | `true` | true/false | Run lint/type-check/test |
| `run_interview` | `true` | true/false | Run interview skill in Phase 0 |
| `dry_run` | `false` | true/false | Plan-only mode: full Phase 0+1, no agent dispatch or git ops |
| `log_prompt_sizes` | `true` | true/false | Store prompt char count per step in state.json for observability |
| `plan_approval` | `true` | true/false | Show agent plan and ask approve/adjust before execution (1.3) |
| `run_test_gen` | `true` | true/false | Auto-run test-gen if implementer skips tests |
| `run_security_audit` | `true` | true/false | Auto-run security-audit if auth/API/DB files touched |
| `run_perf_check` | `true` | true/false | Auto-run perf-check if frontend/bundle files changed |
| `run_changelog` | `true` | true/false | Auto-generate changelog entry and include in PR description |
| `publish_pr_review_report` | `ask` | `ask`/`comment`/`comment-and-ai-artifact`/`none`/`true`/`false` | Whether to publish a concise PR review comment and optional detailed AI markdown artifact |
| `run_deploy` | `ask` | `ask`/`true`/`false` | Post-PR deploy: ask user (ask), always deploy (true), never (false) |

## Dry-Run Mode

When `dry_run: true` is set (or `--dry-run` is passed):

1. **Phase 0** runs fully — context collection, interviewer (if applicable), summary + confirm
2. **Phase 1** runs fully — plan is built and displayed with step tree
3. **Phase 2 is skipped entirely** — no sub-agents dispatched, no git operations
4. **Output:** Full plan tree with agent names, input data shapes, dependencies:

```
Dry-run plan for: issue-4141--pipeline-validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 1: analyze         [issue-analyzer]          → input: issue #4141
Step 2: context         [context-collector]       → input: analysis result, project_dir
Step 3: prepare         [orchestrator]            → creates: feature/pipeline-validation
Step 4: implement       [task-implementer × 3]    → sequential, 3 tasks
Step 5: sanity-check    [orchestrator]            → verifies commits exist
Step 6: review          [code-review × 4]         → parallel
Step 7: fix             [task-implementer]        → conditional: if NEEDS_FIX
Step 8: checks          [orchestrator]            → lint + type-check + test
Step 9: report          [orchestrator]            → aggregates all results
Step 10: pr             [orchestrator + gh CLI]   → conditional: if create_pr
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Estimated sub-agent calls: 11-14 (varies with tasks and review findings)
No changes will be made. Use without --dry-run to execute.
```

5. Ask user: "Execute this plan? (yes / adjust / abort)"

## Budget Guards & Timeouts

The orchestrator enforces resource limits to prevent runaway sub-agents:

| Guard | Default | Description |
|-------|---------|-------------|
| `step_timeout_ms` | `300000` (5 min) | Max time per step. Kill agent if exceeded. |
| `implementation_timeout_ms` | `600000` (10 min) | Max time for full implementation phase |
| `total_job_timeout_ms` | `1800000` (30 min) | Max time for entire job. Abort to Phase 3 if exceeded. |
| `max_retries_per_step` | `2` | Max retries for a failed step before asking user |

**Timeout behavior:**
- When a step times out → mark as `failed`, record partial results if any
- Ask user: "Step X timed out after Y minutes. Retry / Skip / Abort?"
- If total job timeout → force transition to Phase 3 (COMPLETION) with status "timeout"

**Context passing rules (minimal context principle):**
- `issue-analyzer`: receives only issue data + codebase paths (NOT previous job state)
- `context-collector`: receives focus areas + analysis summary (NOT full analysis JSON)
- `task-implementer`: receives only its specific task object + context.md path (NOT other tasks' results)
- Reviewers: receive only the diff range + file list (NOT implementation details)

---

## Error Handling

Each step failure is classified into one of three classes with different recovery paths:

| Class | Meaning | Action |
|-------|---------|--------|
| `terminal` | Unrecoverable — cannot continue | ABORT immediately, surface actionable message |
| `retryable` | Transient failure (bad output, timeout) | Auto-retry up to 2× with **identical prompt**. After 2 failures → escalate to `recoverable` |
| `recoverable` | Partial success or skippable failure | Ask user with specific "continue from here / skip step / abort" options |

### Error Table

| Error | Class | Action |
|-------|-------|--------|
| Issue not found (404) | `terminal` | ABORT — issue-analyzer reports 404 |
| Analysis returns 0 tasks | `recoverable` | Try smart fallback: (1) re-read issue with broader scope, (2) ask user to clarify, (3) if still 0 → ABORT |
| Branch/worktree creation fails | `terminal` | ABORT — report git error. NEVER fall back to `git checkout -b` |
| Interviewer `ready_to_proceed: false` | `terminal` | STOP — tell user which blockers remain |
| Sub-agent returns malformed JSON | `retryable` | Retry with: "Output was malformed. Fix: [errors]. Try again." (max 2×) |
| Sub-agent timeout | `retryable` | Retry with identical prompt (max 2×) |
| Task implementation fails | `recoverable` | Ask: "Step failed. Continue remaining tasks / skip this task / abort?" |
| Job-documenter returns error | `recoverable` | Log warning, continue (documentation is non-blocking) |
| All reviewers fail | `recoverable` | Skip review, add warning to report, continue to checks |
| Fix loop exceeds max_review_iterations | `recoverable` | Log unresolved findings, continue to checks |
| Final checks fail | `recoverable` | Include in report, still propose PR (user decides) |
| gh CLI not available | `recoverable` | Print PR data, user creates manually |

### Retry Protocol (for `retryable` errors)

```
attempt 1: run step normally
→ failure: classify error
→ if retryable: retry with EXACT same prompt + "Fix these errors: [list]"
→ if fails again: escalate to recoverable → ask user
→ if success: continue
```

**Critical:** On retry, use the **same prompt** stored in `state.json → step.prompt`. Never re-derive it — re-derivation causes drift.

---

## Progress Notifications

The orchestrator must keep the user informed during long-running execution. This is especially important for non-interactive channels (Telegram, Slack, CI).

**At each phase transition:**
```
🔄 Phase 0 → Phase 1: Building execution plan...
🔄 Phase 1 → Phase 2: Executing 7 steps...
✅ Phase 2 → Phase 3: Execution complete, generating report...
```

**At each step transition (Phase 2):**
```
📋 Job: issue-4141--pipeline-validation
├─ ✅ Analyze issue — 3 tasks found
├─ ✅ Collect context — context.md ready
├─ ✅ Prepare branch — feature/pipeline-validation
├─ 🔄 Implement (2/3 tasks done)
│  ├─ ✅ task-1: Add validation schema
│  ├─ ✅ task-2: Implement validator
│  └─ 🔄 task-3: Add integration tests...
├─ ⏳ Review
├─ ⏳ Fix (if needed)
├─ ⏳ Final checks
└─ ⏳ PR
```

**Minimum notification interval:** Every 30 seconds during long steps (implementation, review). This prevents the user from thinking the process is stuck.

**If notification tools are unavailable** (no MCP, no Telegram): fall back to inline text output between steps.

---

## Rules of Engagement

1. **DO** ALWAYS collect context in Phase 0 — project directory is MANDATORY, never assume.
2. **DO** build plans dynamically based on intent — not a fixed 8-phase pipeline.
3. **DO** initialize job documentation before executing any step.
4. **DO** document every step result via job-documenter.
5. **DO** parallelize independent tasks and reviewers where safe.
6. **DO** respect dependency order — use wave-based execution for implementation.
7. **DO** limit review → fix loop to max_review_iterations.
8. **DO** present PR proposal to user before creating (unless auto_create_pr).
9. **DO** tell user where documentation is stored at completion.
10. **DO** ALWAYS use `git worktree add` for feature branches — NEVER `git checkout -b`.
11. **DO** run ALL commands in the **worktree directory**, never in the original project.
12. **DO** ask user for confirmation before extending plan (e.g., analyze → implement).
13. **DO** send progress notifications at phase/step transitions and every 30s during long steps.
14. **DO** use auto-detected `package_manager` and `run_command` — never hardcode `npm`.
15. **DO NOT** ask the user anything during execution (after Phase 0) — except for critical failures and plan extension decisions.
16. **DO NOT** push the branch until user confirms (or auto_create_pr).
17. **DO NOT** skip job documentation — it's a core feature, not optional.
18. **DO NOT** create job documentation for sub-agent results directly — orchestrator formats and sends to documenter.
19. **DO** store the prompt used for each sub-agent step in `state.json → step.prompt` before dispatching — required for retry and resume.
20. **DO** classify every step failure as `terminal`, `retryable`, or `recoverable` — never just abort or ask without classifying first.
21. **DO** show agent-explicit plan in 1.3 and ask approve/adjust — unless `plan_approval: false`.
22. **DO** run `sanity-check` after every implement step before dispatching review.
23. **DO** auto-trigger `test-gen` if implementer produced no test files (unless `run_test_gen: false`).
24. **DO** auto-trigger `security-audit` if diff touches auth/API/DB/env files (unless `run_security_audit: false`).
25. **DO** include changelog entry in PR body (unless `run_changelog: false`).
26. **DO NOT** deploy without user confirmation (unless `run_deploy: true` explicitly set).

---

## Configurable Jobs Root

The jobs documentation root is configurable, not hardcoded:

**Resolution order:**
1. `JOBS_ROOT` passed explicitly by the orchestrator in the sub-agent dispatch prompt
2. `GDMETAPRO_JOBS_ROOT` environment variable (if set)
3. Default: `.metaproject/jobs/`  ← project-local (PROJECT_DIR is known by Phase 0.2)

```bash
JOBS_ROOT="${GDMETAPRO_JOBS_ROOT:-.metaproject/jobs}"
```

All references to job paths in sub-agent prompts must use the resolved `JOBS_ROOT`.

---

## Post-Mortem (for failed/aborted jobs)

When a job ends with status `aborted`, `timeout`, or has unresolved critical issues:

1. **Auto-generate post-mortem** document:
```markdown
# Post-Mortem: <job-name>

## Timeline
- Phase 0 completed: <timestamp>
- Phase 2, step "implement" started: <timestamp>
- Step "task-3" failed after 2 retries: <timestamp>
- Job aborted by user: <timestamp>

## What Went Wrong
- <Step name> failed with: <error class> — <error message>
- Root cause hypothesis: <analysis>

## What Worked
- <N> tasks completed successfully
- Context collection was accurate

## Recommendations for Retry
- Fix <specific issue> before re-running
- Consider splitting task-3 into smaller subtasks
- Increase step_timeout_ms if timeout was the issue
```

2. Save to `.metaproject/jobs/<job-name>/post-mortem.md`
3. Include in final user message: "Post-mortem saved to `.metaproject/jobs/<job-name>/post-mortem.md`"

---

## Metrics Collection

The orchestrator tracks timing and token usage for each step to enable optimization over time.

**Collected per step:**
```json
{
  "step_id": "implement",
  "started_at": "2024-03-15T10:30:00Z",
  "completed_at": "2024-03-15T10:35:22Z",
  "duration_ms": 322000,
  "total_tokens": 84500,
  "status": "success",
  "retries": 0
}
```

**Saved to:** `.metaproject/jobs/<job-name>/metrics.json`

**Aggregated in report:**
```markdown
## Metrics
| Step | Duration | Tokens | Retries |
|------|----------|--------|---------|
| Analyze | 45s | 12K | 0 |
| Context | 30s | 8K | 0 |
| Implement | 5m 22s | 84K | 0 |
| Review | 1m 10s | 25K | 0 |
| **Total** | **7m 47s** | **129K** | **0** |
```

This data helps identify which steps are bottlenecks and whether budget guards need adjustment.

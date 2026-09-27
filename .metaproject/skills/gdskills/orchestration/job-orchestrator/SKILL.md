---
name: job-orchestrator
description: "Use when a GitHub issue or complex intent needs to be analyzed, planned, and implemented end-to-end with sub-agents. NOT for: the same pipeline under Task Manager flow state (use flow-orchestrator)."
triggers:
  - "implement issue"
  - "full workflow"
  - "orchestrate task"
  - "Issue to PR"
  - "Run pipeline"
  - "Analyze and implement"
  - "Full implementation"
  - "Auto-implement"
  - "Auto-implement issue"
  - "Orchestrate issue"
  - "Run issue pipeline"
  - "Full issue implementation"
metadata:
  author: "MrCipherSmith"
  version: "3.2.0"
  category: "orchestration"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely.
This skill is for orchestrators and interactive session-level routing only.
Proceed directly with your assigned task.
</SUBAGENT-STOP>

# Job Orchestrator

## Purpose

Dynamic orchestrator that builds execution plans based on user intent. Unlike a fixed pipeline, the orchestrator adapts its workflow to what the user actually needs — from "just analyze this issue" to "implement, review, and create a PR". It dispatches sub-agents (`issue-analyzer`, `context-collector`, `tests-creator`, `task-implementer`, `code-verifier`, `review-orchestrator`) and persists every step, document and retry through `keryx job`, which writes `.metaproject/jobs/<job-name>/`.

**The package is the state.** `keryx job` is the only writer of `state.json`; it validates every write against the registered contract `job-orchestrator-state` and refuses one that does not conform. Never hand-write `state.json`, and never hold a step's outcome only in this session — a step recorded nowhere is a step that did not happen as far as the next session is concerned.

**Execution metrics (opt-in):** when a USER runs this orchestrator directly (not as a dispatched subagent), at the start ask "Collect execution statistics for this run? (yes/no)" per `.metaproject/rules/core/execution-metrics.md`. If yes, append the `## Execution Metrics` section at the end and save it under the job dir (`jobs/<job>/metrics/`). Never ask or emit it when dispatched as a subagent.

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

Before asking any questions, list existing job packages:

```bash
keryx job list --json
```

Every entry carries `phase`, `stepsDone`/`stepsTotal` and `nextStep`. A job whose
`phase` is not `COMPLETION` is unfinished.

1. If an unfinished job exists, ASK the user:
   "Found unfinished job '<job-name>' (<stepsDone>/<stepsTotal> steps, next: <nextStep>).
   Resume it or start a new orchestrated job?"
2. If resume → read the package and jump directly to the step it names:

   ```bash
   keryx job status <job-name> --json
   ```

   `next_step` is the first step that is neither `completed` nor `skipped` — computed
   from the file, not recalled. `retries` gives the recorded attempt count per step, so
   a resumed session continues from the real number instead of restarting at zero, and
   `documents` lists what has already been produced.
3. If new → proceed to 0.1.

There is no `paused` status and nothing writes one. A job is unfinished exactly when a
step is still open, and `keryx job status` is what reports that.

### 0.1 Determine User Intent

Parse the user's request to identify the intent:

| User Says | Intent | Plan Type |
|-----------|--------|-----------|
| "Implement issue #N" / "Issue to PR" | `implement` | Full: analyze → branch → implement → verify → review → fix → PR |
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
Load skill: skills/gdskills/planning/interviewer/SKILL.md

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
   Present detected branch and ask to confirm. No hardcoded default — and
   `input-contract.schema.json` declares none either, so the contract cannot
   reintroduce one behind the question.

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
  Base:      <detected base branch>
  Create PR: yes
  Job name:  issue-4141--pipeline-validation

Proceed? (yes / adjust)
```

This is the **operator** gate and it is not governed by `skip_confirmation`. That
setting is `{"const": true}` in `input-contract.schema.json` and means exactly one
thing: dispatched sub-agents run without asking the operator to approve each
dispatch. It has never covered this question, and the two are named apart here so
the contract and the prose stop reading as a contradiction. The gate that *can* be
turned off is `plan_approval` in 1.3.

`job_name` must match `^[a-z0-9-]+$` — the pattern `state.schema.json` declares and
`keryx job init` enforces before it builds a path from the value. `issue-4141--pipeline-validation`
conforms; anything with a slash, a space or an uppercase letter is refused.

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
  8.  { id: "review",          type: "review",   agent: "review-orchestrator", depends: ["verify"] }
  9.  { id: "security",        type: "security", agent: "security-audit",  depends: ["implement"], conditional: true }
  10. { id: "fix",             type: "fix",      agent: "task-implementer", depends: ["review"], conditional: true }
  11. { id: "verify-post-fix", type: "verify",   agent: "code-verifier",   depends: ["fix"], conditional: true }
  12. { id: "perf-check",      type: "perf",     agent: "perf-check",      depends: ["verify"], conditional: true }
  13. { id: "report",          type: "report",   agent: "orchestrator",    depends: ["verify"] }
  14. { id: "pr",              type: "pr",       agent: "orchestrator",    depends: ["report"], conditional: true }
  15. { id: "deploy",          type: "deploy",   agent: "deploy",          depends: ["pr"], conditional: true }
```

This is the plan `keryx job init --intent implement` writes, step for step. The `agent`
field is the **label recorded in the plan**, not a dispatch target: the `review` step is
executed by `review-orchestrator` (2.6), and `orchestrator` means this skill does the
step itself. Read the recorded plan back at any time with `keryx job status <job-name>`.

**Conditional step triggers** — one row per step, no step listed twice:

| Step | Runs when |
|------|-----------|
| `sanity-check` | always — verifies ≥1 commit was made |
| `tests-creator` | always — mandatory TDD step before every task-implementer wave |
| `verify` | always — `code-verifier` is the mandatory quality gate after implementation |
| `security` | diff touches `auth/`, `api/`, migrations, schema files, or `.env` |
| `fix` | review or verify produced a `blocker` or `major` finding |
| `verify-post-fix` | after `fix` ran — confirms the fix resolved the findings |
| `perf-check` | diff contains `*.tsx`, `*.jsx`, `*.css`, `dist/` or `build/` files |
| `pr` | `create_pr: true` |
| `deploy` | user answers "yes" to the post-PR staging deploy prompt |

Severities are the canonical four — `blocker`, `major`, `minor`, `info` — from
`review-finding.schema.json`. They are the only vocabulary this skill uses, so the
`fix` trigger and the counts in the report are read off the same field.

Note: `security` runs in parallel with `review` (both depend on `implement` results, no overlap).

**A conditional step is not exempt from the record.** Every step in the plan is
written into the package by `keryx job init`, and `keryx job complete` refuses while
any step is neither `completed` nor `skipped`. A condition that did not fire is
closed explicitly:

```bash
keryx job step <job-name> perf-check --status skipped --reason "no frontend files in diff"
```

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

### 1.2 Create the Job Package

Create the package with the CLI. This is one command, run by the orchestrator — not
a sub-agent dispatch:

```bash
keryx job init --name <job-name> --intent implement|analyze|review|custom --project <project_dir>
```

It creates `.metaproject/jobs/<job-name>/` containing:

- `state.json` — validated against the registered contract `job-orchestrator-state`
  on **every** write. A state that does not conform is refused, not written.
- `journal.md` — append-only, one line per recorded event, written by `keryx job`.
- the plan for the chosen intent, every step `pending`, with `plan.current_step`
  already pointing at the first one.

`--intent` defaults to `implement`. `--project` defaults to the current directory;
pass the path collected in 0.2 explicitly rather than relying on the default.

**Refusals to expect, and what each means:**

| Message | Cause |
|---------|-------|
| `Job package already exists: .metaproject/jobs/<name>` | The package is there. Run `keryx job status <name>` and resume it (0.0) instead of re-initialising. |
| `Invalid --name "<name>"` | The name is not `^[a-z0-9-]+$`. |
| `Invalid --intent "<value>"` | Not one of `implement`, `analyze`, `review`, `custom`. |

Confirm the result before proceeding:

```bash
keryx job status <job-name>
```

It prints the phase, the step list with statuses, and `next:` — the step execution
starts from.

### 1.3 Display Plan + Agent Approval

Display the plan the package actually holds — do not retype it from memory:

```bash
keryx job status <job-name>
```

There is **one** plan. Every step listed in 1.1 is in it, including the conditional
ones; a conditional step is one whose trigger may not fire, not one that is absent
until somebody adds it. For the `implement` intent that is fifteen steps:

```
Execution plan — 15 steps (◦ = conditional):

  Step 1   analyze          issue-analyzer              → issue #<N>
  Step 2   context          context-collector           → project context + test framework
  Step 3   prepare          orchestrator                → feature branch worktree
  Step 4   tests-creator    tests-creator × <tasks>     → RED test stubs per task (MANDATORY)
  Step 5   implement        task-implementer × <tasks>  → <N> tasks make tests GREEN (wave-parallel)
  Step 6   sanity-check     orchestrator                → verify commits exist
  Step 7   verify           code-verifier               → lint + type-check + tests + imports (MANDATORY)
  Step 8   review           review-orchestrator         → managed review round
  Step 9 ◦ security         security-audit              → auth/API/DB/env files touched
  Step 10◦ fix              task-implementer            → blocker or major findings
  Step 11◦ verify-post-fix  code-verifier               → after fix
  Step 12◦ perf-check       perf-check                  → frontend/bundle files changed
  Step 13  report           orchestrator                → final summary
  Step 14◦ pr               orchestrator + gh CLI       → create_pr=true
  Step 15◦ deploy           deploy                      → user asked for a staging deploy

Proceed? (yes / adjust: "skip fix", "remove pr", etc.)
```

**If user adjusts:** record the decision in the package rather than holding it in
this session:

```bash
# "skip fix" — close it now, with the reason on the record
keryx job step <job-name> fix --status skipped --reason "operator asked to skip at plan approval"
# "remove pr"
keryx job step <job-name> pr --status skipped --reason "create_pr: false"
```

Then re-display with `keryx job status <job-name>` and ask again. A step the operator
removed is `skipped` with a reason, never silently dropped — that is the difference
between a plan somebody changed and a plan that quietly shrank.

**If `plan_approval: false`** (automation setting) → skip this display and proceed directly.

---

## Phase 2: EXECUTION

Execute each step in plan order, documenting results after each step.

### 2.1 General Execution Loop

Every step in the loop is bracketed by two `keryx job` calls. The package, not this
session, is what says a step ran.

```
FOR step in PLAN:
  IF step.conditional AND condition_not_met:
    keryx job step <job-name> <step-id> --status skipped --reason "<why the trigger did not fire>"
    CONTINUE

  2.1.1  Open the step:
           keryx job step <job-name> <step-id> --status in-progress
         Re-entering a step that was already opened increments `metrics.steps[].retries`
         — that counter is the attempt budget, and it survives a session restart.

  2.1.2  Execute step (see step-specific instructions below)
         If the sub-agent returns a malformed result or fails to follow formatting rules, run an explicit retry:
         "The previous output was malformed. Fix these errors: [errors] and try again." (Max 2 retries before counting as critical failure).
         Re-open the step before each retry so the retry is counted.

  2.1.3  Collect result

  2.1.4  Write the document to disk, then record it in the package:
           keryx job document <job-name> --type analysis|implementation-report|review|verification-report --file <path>
         The file must already exist — `job document` refuses a `--file` it cannot
         find with "Write the document first, then record it." It copies the file
         into the package and adds it to `documentation.documents_created`.
         Re-recording the same type replaces the file and leaves one entry.

  2.1.5  Confirm what the package now holds:
           keryx job status <job-name>
         The step list, the retry counts and the recorded documents come from
         `state.json`. This is the job index; there is no README to update.

  2.1.6  Close the step:
           keryx job step <job-name> <step-id> --status completed

  IF step failed critically:
    keryx job step <job-name> <step-id> --status failed --reason "<what failed>"
    Ask user: "Step '<name>' failed. Continue with remaining steps or abort?"
    IF abort: skip to Phase 3 (COMPLETION)
```

**`failed` is not terminal.** `keryx job complete` refuses while any step is `failed`
or still open, and names them. A job that genuinely ends with a step unfinished is
closed by deciding what happened to that step — `--status skipped --reason "<why>"` —
which leaves the decision on the record instead of leaving the package half-written.

Only four document types exist: `analysis`, `implementation-report`, `review`,
`verification-report`. Anything else is refused with the valid list.

### 2.2 Step: ANALYZE

Dispatch `issue-analyzer` as a sub-agent.

**Prepare prompt:** Read `skills/gdskills/orchestration/issue-analyzer/orchestrator-prompt.md`
and fill in:
- Issue URL or repo+number
- Codebase paths with roles
- Automation settings (skip_confirmation: true, search_depth: focused)

That file ships with the skill. If the read fails, the path is wrong or the skill is
not installed — stop and say so. Do not proceed on an improvised prompt: a missed
template is exactly the failure that hid behind the old "(if it exists)" hedge.

**Launch:**
```
Task({
  description: "Issue analysis: #<N>",
  subagent_type: "general-purpose",
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

**Document:** write the analysis, then record it:

```bash
keryx job document <job-name> --type analysis --file <path/to/analysis.md>
```

It lands in the package as `analysis.md` (the source extension is preserved, so a
`.json` analysis lands as `analysis.json`) and appears in `documents` on the next
`keryx job status`.

**For `analyze` intent:** After documenting, present analysis to user. Ask:
```
Analysis complete. Found <N> tasks.
Want me to implement this? I'll create a feature branch and run the full pipeline.
○ Yes, implement
○ No, analysis is enough
```
If "Yes" → follow Plan Extension below: create an `implement` package and continue there. Do not rewrite this package's plan.
If "No" → skip to Phase 3 (COMPLETION).

### 2.3 Step: CONTEXT

Dispatch `context-collector` to build the unified context document.

**Prepare prompt:** Use the template from `skills/gdskills/orchestration/context-collector/SKILL.md`:

```
Task({
  description: "Collect context: <job-name>",
  subagent_type: "general-purpose",
  prompt: |
    You are the context-collector agent. Your task is to research and build
    a context document for the current job.

    Load the skill from: skills/gdskills/orchestration/context-collector/SKILL.md

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

**After context is collected:** the orchestrator holds the context path and puts it
into every subsequent dispatch prompt:

```
CONTEXT_LOCATION: <JOBS_ROOT>/<job-name>/ai/context.md
```

**Context versioning:** the file lives at this one fixed path and is overwritten in
place on every update — never written to a new, version-numbered filename. Each
collect/update instead increments the `Version` field in the document's own
"Document Metadata" table and appends a line to its `Update Log` section (see
context-collector SKILL.md §4.1, §4.3); that table on disk is the current version.

`state.json` does not carry a context pointer and nothing writes one — do not tell a
sub-agent to look for one. The orchestrator passes the path (Constructing Subagent
Context, below); subagents receive, they do not retrieve.

**Triggering context updates during execution:**

If during later steps (implement, review) a sub-agent reports missing context or a new library is discovered:

```
Task({
  description: "Update context: <job-name>",
  subagent_type: "general-purpose",
  prompt: |
    You are the context-collector agent. Update the existing context.

    Load the skill from: skills/gdskills/orchestration/context-collector/SKILL.md

    ACTION: update
    JOB_NAME: <job-name>
    JOBS_ROOT: <JOBS_ROOT>
    PROJECT_DIR: <project_dir>
    CONTEXT_VERSION: <current version + 1>  ← written into ai/context.md's Version field; file overwritten in place

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
if [ -f <worktree_path>/bun.lock ] || [ -f <worktree_path>/bun.lockb ]; then
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

> **Concurrency**: every subsequent git command MUST use `git -C <worktree_path>`, never a bare `git`, and MUST NOT `git stash` or `git add -A`/`--all`/`.` — see `rules/core/git-concurrency.mdc`. Pin each dispatch to `<worktree_path>` explicitly; a dispatched agent's first action is `cd <worktree_path> && pwd && git branch --show-current`, re-checked before its first write.

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

> **Carry `package_manager` and `run_command` into every subsequent dispatch prompt** — all subsequent steps use these instead of hardcoded `npm`. They are not persisted; the orchestrator holds them for the run and states them explicitly in each dispatch.

**Record:** close the step and put the branch on the record:

```bash
keryx job step <job-name> prepare --status completed --reason "feature/<branch-slug> at <worktree_path>"
```

`--reason` is appended to the package's `journal.md` with a timestamp, which is where
"what branch did this job use" is answerable after the session ends.

### 2.5 Step: TESTS-CREATOR + IMPLEMENT

tests-creator runs before task-implementer for every task, with no exceptions.

There is no `wave-executor` agent. Each wave is two dispatches the orchestrator makes
itself — `tests-creator`, then `task-implementer` — and both are real, installed
skills. Nothing is delegated to an intermediary that does not exist.

**CONTEXT BUDGET RULE: instruct every dispatched agent to write its full result to a
file and return only a compact summary line.** The orchestrator's context grows with
what agents *return*, not with what they do; a returned result file path costs a line,
an inlined verification log costs thousands. After 3–4 waves of inlined results the
session freezes on context reload, which is the failure this rule exists to avoid.

---

#### Wave ordering

Waves come from `dependency_order` in `ANALYSIS_RESULT`, which `issue-analyzer` already
returned topologically sorted and which 2.2 validated. Wave 1 is every task with no
unsatisfied dependency; wave N+1 is every task whose dependencies are all in waves 1..N.
Do not re-derive an ordering the analysis already produced.

#### Execution pattern

```
FOR wave_index, wave_tasks in enumerate(WAVES):

  keryx job step <job-name> tests-creator --status in-progress      # wave 1 only
  # Step A — tests-creator (MANDATORY, run first)
  Dispatch one tests-creator per task in this wave, in a SINGLE turn (parallel).
  Wait for ALL of them. Collect TEST_SPECS[task_id] from each response.
  keryx job step <job-name> tests-creator --status completed         # last wave only

  # Parallel safety check, before Step B:
  # if two tasks in this wave share a target_file, dispatch them sequentially.

  keryx job step <job-name> implement --status in-progress           # wave 1 only
  # Step B — task-implementer (after all test stubs are committed)
  Dispatch one task-implementer per task in this wave, in a SINGLE turn (parallel),
  each carrying test_case_specs: TEST_SPECS[task_id].
  Wait for ALL of them.

  Read each result's STATUS line:
    DONE / DONE_WITH_CONCERNS → accept it (record every concern)
    BLOCKED                   → do not accept it; read its result file

  # Task boundary commit, for EVERY accepted result, before anything else,
  # whatever auto_commit was (see "Task boundary commit" below):
  FOR each accepted result: commit its still-changed reported paths, or skip

  any BLOCKED → STOP, resolve or ask the user
  otherwise   → continue to next wave
```

#### tests-creator dispatch (Step A)

```
Task({
  description: "Wave <N> tests: <task_id>",
  subagent_type: "general-purpose",
  prompt: |
    Load skill: skills/gdskills/quality/tests-creator/SKILL.md

    ## Task
    <the single task object>

    ## Workspace
    - worktree_path:    <absolute path>
    - branch:           <branch name>
    - package_manager:  <pm>
    - run_command:      <runner>
    - context_path:     <JOBS_ROOT>/<job-name>/ai/context.md

    ## Required response
    Begin with STATUS: <STATUS>. Return the test_case_specs for this task and
    nothing else inline; write anything longer to
    <JOBS_ROOT>/<job-name>/results/<task_id>-tests.json and return the path.
})
```

#### task-implementer dispatch (Step B)

```
Task({
  description: "Wave <N> implement: <task_id>",
  subagent_type: "general-purpose",
  prompt: |
    Load skill: skills/gdskills/orchestration/task-implementer/SKILL.md

    ## Task
    <the single task object, WITH test_case_specs: TEST_SPECS[task_id]>

    ## Workspace
    - worktree_path:    <absolute path>
    - branch:           <branch name>
    - package_manager:  <pm>
    - run_command:      <runner>
    - issue_number:     <N>
    - job_name:         <job-name>
    - context_path:     <JOBS_ROOT>/<job-name>/ai/context.md

    ## Automation (task-implementer input `automation`)
    - auto_commit:      <implementer_settings.auto_commit>   # false: do not commit; report exact paths

    ## Required response format (compact — no inline JSON)
    STATUS: DONE
    Task: <task_id>
    Commits: [abc1234 feat(x): ...]    # auto_commit=false: Commits: none (auto_commit=false)
    Tests: <N passed, M failed>
    Result file: <JOBS_ROOT>/<job-name>/results/<task_id>.json

    Write full detail to the result file. Do NOT inline it.
})
```

**Who commits is set by the dispatch, never by a default.** Step B always passes
`auto_commit` explicitly. The worker's own default is `true`, so a dispatch that
leaves it out gets a worker that commits even when `implementer_settings.auto_commit`
is `false`.

**Task boundary commit, for every accepted result, whatever `auto_commit` was:**
a task is not done until its diff is committed (`rules/core/git-concurrency.mdc`
rule 4, "Reporting Back"). As soon as a result is accepted (`STATUS: DONE` or
`DONE_WITH_CONCERNS`), take its reported `files_modified`/`files_created`/
`files_deleted` from the result file and commit the ones git still shows as
changed, never `-A`/`--all`/`.`:
```bash
set -- <each files_modified/files_created/files_deleted path, single-quoted: 'src/a.ts' 'docs/b c.md'>   # may be none; an unquoted path with a space splits and is skipped
PENDING=()
for p in "$@"; do
  [ -n "$(git -C <worktree_path> status --porcelain -- "$p")" ] && PENDING+=("$p")
done
if [ ${#PENDING[@]} -eq 0 ]; then
  echo "boundary commit: nothing left to commit, skipped"
else
  git -C <worktree_path> add -- "${PENDING[@]}"
  git -C <worktree_path> commit -m "<type>(<scope>): <task description>

task: <task_id>" -- "${PENDING[@]}"
fi
```
With `auto_commit=false` this commits exactly the worker's paths. With
`auto_commit=true` the worker already committed, so nothing is left and the step
skips. That is the expected outcome, not an error. If paths remain after an
`auto_commit=true` worker, it left part of its diff uncommitted: the step
commits it, and you record that as a concern. Each path is checked on its own
because `git status --porcelain --` with no path lists the whole tree, `git add`
fails on a path that is neither on disk nor tracked, and `git commit` with
nothing staged exits 1. The trailing `-- "${PENDING[@]}"` commits only these
paths, so a file another lane staged is not swept into this commit.

**Each wave runs in ONE worktree.** The worktree created in 2.4 is the whole job's
workspace — waves are ordered, not isolated from each other, and a later wave sees
what an earlier one committed. That is what makes the dependency order mean anything.

**After all waves, document:** write the implementation report, then record it:

```bash
keryx job document <job-name> --type implementation-report --file <path/to/implementation-report.md>
keryx job step <job-name> implement --status completed
```

The report summarises every wave: commits, files, test totals, and each task's final
STATUS.

### 2.5.1 Post-Implementation Checkpoint

After all waves complete, check if tests were created. If not, offer `test-gen`:

```
# Derive all modified files from the per-task result files
ALL_FILES = collect from <JOBS_ROOT>/<job-name>/results/*.json

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
- A → continue to the REVIEW step (2.6)
- B → run `git diff <merge_base>..HEAD --stat` and `git diff <merge_base>..HEAD`, then re-ask
- C → skip REVIEW and FIX, go to VERIFY (2.8) → PR. Record both:
  `keryx job step <job-name> review --status skipped --reason "operator chose to skip review"`
- D → close the open steps with a reason and go to Phase 3:
  `keryx job step <job-name> <step-id> --status skipped --reason "operator stopped here to continue manually"`

**Wait for the answer.** There is no default and no timer: this skill runs as a model
in a turn-based session, and nothing here can observe wall-clock time passing while a
user does not reply. A "default after N seconds" could never fire, so it is not
offered.

### 2.5.2 Step: IMPLEMENT SANITY CHECK

Lightweight verification after all waves complete, **before** launching review.
This catches the case where a task-implementer reports `STATUS: DONE` but made no
actual git changes.

```bash
# Run in worktree directory
git diff --stat <merge_base>..HEAD
git log <merge_base>..HEAD --oneline
```

**Gate conditions:**

| Check | Pass | Fail action |
|-------|------|-------------|
| At least 1 commit exists | ≥1 commit | `implementer_settings.auto_commit=true`: `retryable` — re-dispatch the task-implementers for that wave with: "No commits were made. Implement the changes and commit them." `auto_commit=false`: the task-boundary commit (wave loop, after Step B) should already have committed each accepted result's files — if none exist, `retryable`: re-run that commit step for the wave's result files instead of re-dispatching workers. |
| At least 1 file modified | ≥1 file changed | Same as above |
| Claimed files actually modified | All files named in the result files appear in the diff | Log discrepancy as a concern, continue |

Re-open the step before re-dispatching, so the attempt is counted:

```bash
keryx job step <job-name> implement --status in-progress
```

`metrics.steps[].retries` for `implement` goes up by one. Read it back with
`keryx job status <job-name> --json` — the count is on disk, so it is still right
after a session restart.

**If the retry also produces no commits** → classify as `terminal` and stop:

```bash
keryx job step <job-name> sanity-check --status failed --reason "task-implementer reported DONE twice with no git changes"
```

```
"task-implementer returned STATUS: DONE twice but made no git changes.
Please implement manually and re-run from the review step."
```

**Record the outcome** in the journal, where it survives the session:

```bash
keryx job step <job-name> sanity-check --status completed \
  --reason "<N> commits, <M> files changed, +<A>/-<R> lines"
```

There is no `sanity_check` field in `state.json` and nothing writes one — the
journal line is the record.

---

### 2.6 Step: REVIEW

`review-orchestrator` is the review path. It is not one strategy among several: it is
the only entry point that produces a **managed review record**, and every round this
skill runs is a round that must be citable afterwards. The legacy alternatives —
launching `code-ai-review` / `code-learned-review` / `code-style-review` by hand, or the
never-bundled `code-review` 4-agent skill — are gone. They emitted prose into a chat
transcript and nothing else, which is precisely the failure the managed pipeline
replaced.

A pull request driven by this orchestrator has to pass the completion gate shipped in
0.2.71. Its five conditions are what 2.6 and 2.7 are built to satisfy:

| Gate condition | Satisfied by |
|---|---|
| every fix round has a managed record | `keryx review start` before, `keryx review ingest` after (2.6.1, 2.7) |
| every finding has a terminal disposition | `keryx review complete --finding … --disposition … --evidence …` (2.7) |
| scope B is recorded when a scope-B reviewer ran | `keryx review blast-radius --json` → `review ingest --blast-radius` (2.6.1) |
| no inbound PR comment is unanswered | `keryx review comments collect` every round, `… reply --final` once (2.6.2) |
| verification stats exist | `review-verifier` dispatched, passed as `--verifications` (2.6.1) |

#### 2.6.0 Review Scope Selection

Ask which reviewer set to use. The flags are `review-orchestrator`'s, and they select
reviewers — there is no "quick vs thorough" mode:

```
Which reviewers should run on this branch?

  A) Auto-detect from the diff (recommended) — review-orchestrator picks from changed files
  B) Named domains — e.g. --backend --security, --frontend --testing-practices
  C) Everything — --all
  D) Skip review entirely

> pick a letter
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

Which reviewers are even applicable is **detected, not eyeballed**:

```bash
keryx review stack --json
```

It reads `package.json` once and every installed review-category skill's declared
`metadata.stack_requires`, and reports per reviewer whether the requirement is met.
Show only what it includes, and carry its exclusions with their reasons into the
report — a reviewer silently absent reads as a reviewer that found nothing.

**Auto-select** (skip these questions) when:
- `review_flags` is explicitly set in automation settings → use that
- `convention_reviewers` is explicitly set in automation settings → use that for optional convention reviewers
- User already chose at Post-Implementation Checkpoint (2.5.1 option A) → use auto-detect (A)

The selection is held for this run and named in the dispatch. There is no
`convention_reviewers` field in `state.json` and nothing writes one; the choice is
carried in the dispatch prompt and reported in 2.9.

#### 2.6.1 Execute the Round

**Step 1 — check the budget before dispatching, while stopping is still possible.**

```bash
keryx review budget --spent <usd-so-far> --outstanding <subagents this orchestrator has in flight>
```

`--outstanding` is not optional here. `src/review/caps.ts` names `job-orchestrator`
as the outermost of the three nesting levels — `job-orchestrator` →
`flow-orchestrator` → `review-orchestrator` — that its cap of 4 in-flight reviewers
was chosen to survive. keryx is a CLI invoked once per command; it cannot observe
subagents running inside another orchestrator's process. **The cap binds the nested
total only when the parent declares its own in-flight count.** Omit `--outstanding`
and the cap bounds the reviewer fan-out alone, which the record then states plainly.

A non-zero exit means the spend ceiling (3 USD by default) is reached: stop and ask
the user rather than dispatching another fan-out.

**Step 2 — open a managed round.**

```bash
keryx review start --target branch --ref <feature-branch> --head "$(git -C <worktree> rev-parse HEAD)"
# reviewing an existing PR instead:
keryx review start --target pull-request --ref <pr-number> --head <pr-head-sha>
```

**A fix round is managed, not optional.** A round whose findings were never ingested
cannot be cited as a completed round, because nothing durable records what it found.

**Step 3 — collect inbound PR comments, every round.**

```bash
keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha> \
  --self <our-login> --round <n> --out <JOBS_ROOT>/<job-name>/comments-r<n>.json
```

`--sha` is required and is the commit collected against; the completion gate compares
it to the PR head, so a collection that ran before the comments arrived reads as
stale rather than clean. Bot reviewers count as reviewers. Do **not** reply yet —
replies happen once, in 2.7, after the last round.

**Step 4 — build both scopes.**

```bash
BASE_SHA="$(git -C <worktree> merge-base HEAD <base_branch>)"
keryx review scope --ref "$BASE_SHA" --json > <JOBS_ROOT>/<job-name>/scope.json
keryx review blast-radius --ref "$BASE_SHA" --json > <JOBS_ROOT>/<job-name>/blast-radius.json
```

Scope A (`review scope`) is the bounded diff, with every drop recorded and its reason.
Scope B (`review blast-radius`) is what the change can break — the regression set.
**Keep both files.** `review ingest --blast-radius <file>` is refused on any round that
dispatched `review-regression`, which is every recommended and full round, and an
ingest carrying a scope-B finding without the record is refused in code.

**Step 5 — compute the model per dispatch, never by hand.**

```bash
keryx review tier --scope <scope> --diff-lines <n> --findings <n> [--security] [--verifier reasoning] --json
```

Paste the `model` block it prints into that dispatch. `model_strategy: "current"` is
gone: it meant "do not switch models", which is exactly the behaviour this command
replaced. The command names no model — it ranks what the provider reports at runtime
and, when it cannot rank anything, prints `inherit: true`, which means the dispatch
runs on the session model. That is a correct answer, not a failure.

**Step 6 — dispatch `review-orchestrator`.**

```
Task({
  description: "Review round <n>: <job-name>",
  subagent_type: "general-purpose",
  prompt: |
    Load skill: skills/gdskills/review/review-orchestrator/SKILL.md

    flags:            <selected flags, e.g. --backend --security --testing-practices>
    commit_range:     <BASE_SHA>..HEAD
    issue_url:        <issue URL, when the job has one — enables the Stage 1 spec gate>
    context_doc:      <JOBS_ROOT>/<job-name>/ai/context.md
    verification_mode: annotate
    managed_review:   { mode: "review-flow", target: "branch", target_ref: "<feature-branch>" }
    is_fix_round:     <true on any round after the first>
    pr_comments:      { enabled: <true when a PR exists> }

    Emit the unified report AND the fenced ```json keryx:findings``` block.
    Dispatch review-verifier (Wave C) over the consolidated findings and return
    its verification claims as a file path.
})
```

**Step 7 — verification is part of the round, not an extra.** `review-orchestrator`
dispatches `review-verifier` in Wave C over the consolidated findings. The verifier
**runs something** and can only delete — it never raises a severity, adds a finding,
or rewrites one, and it never verifies a finding raised by the same reviewer. Its
claims are merged by the CLI, not by hand.

**Step 8 — ingest the round.** This is what makes it citable.

```bash
keryx review ingest --report <path/to/review-report.md> --ref <feature-branch> \
  --head "$(git -C <worktree> rev-parse HEAD)" \
  --scope <JOBS_ROOT>/<job-name>/scope.json \
  --blast-radius <JOBS_ROOT>/<job-name>/blast-radius.json \
  --verifications <path/to/verifications.json> --verification-mode annotate \
  --refuted <path/to/refuted.json> \
  --spent <usd-so-far> --outstanding <subagents in flight>
```

An unrecognised option is **refused, not ignored** — a silently dropped flag writes
nothing and still reports success. `--refuted` carries findings this round raised and
then dismissed; without it the package keeps only the survivors of an unlogged triage.

**Findings are the canonical shape.** One vocabulary, everywhere in this skill:

- severities are `blocker`, `major`, `minor`, `info` — `review-finding.schema.json`;
- the report ends with **exactly one** fenced block whose info string is
  ` ```json keryx:findings ` — ingest reads that block, not the prose, and a round
  that emits only prose cannot seed the next one;
- `reviewer` is the reviewer that actually produced the finding, never the
  orchestrator;
- identity for dedupe and for the stuck check is `dedupe_key` when the finding has
  one, otherwise reviewer + file + symbol + problem — never the display id, which is
  per-report.

**Classify:**
```
NEEDS_FIX = count(blocker) > 0 OR count(major) > 0
```

**Document:** record the report in the job package too, so the job and the review
record point at each other:

```bash
keryx job document <job-name> --type review --file <path/to/review-report.md>
```

#### 2.6.2 PR Review Report Publication

If this job is reviewing an existing GitHub PR, or a PR number was resolved before the
review step, ask whether to publish the consolidated review report — after the round is
ingested and before any fix decisions.

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
- Default is C. Never publish to a PR without explicit user confirmation or `publish_pr_review_report: comment`, `publish_pr_review_report: comment-and-ai-artifact`.
- If the user chooses A, delegate concise comment formatting to `review-orchestrator`'s PR Review Report Publication contract.
- If the user chooses B, also generate `.metaproject/jobs/<job-name>/review-ai-report.md` using `review-orchestrator`'s Detailed AI Markdown Artifact contract, and include in the comment's `Meta` section both an `AI artifact` path and an `AI artifact description` row explaining that the file carries detailed findings, fix guidance, patch guidance, regression coverage, validation plan, and follow-up agent context.
- **If no PR exists yet**, do not ask now and do not stash a pending decision — nothing persists one. Ask this question again after the PR step (2.10) creates the PR, when the answer can actually be acted on.
- The decision is acted on immediately or not at all. There is no `publication_plan` field in `state.json`; what was published is stated in the 2.9 report.

**Automation values:**
- `publish_pr_review_report: ask` -> ask the question above.
- `publish_pr_review_report: comment` -> publish the concise PR comment only.
- `publish_pr_review_report: comment-and-ai-artifact` -> publish the concise PR comment and create the detailed AI markdown artifact.
- `publish_pr_review_report: none` -> do not publish.

#### 2.6.3 Post-Review Checkpoint

After the round is ingested, present findings and ask the user:

```
Review round <n> complete:
  🔴 <N> blocker  🟠 <M> major  🟡 <K> minor  🔵 <L> info
  verified: <V> claims recorded, <R> findings refuted
  inbound PR comments this round: <C>

  A) 🔧 Auto-fix and continue (fix blocker + major)
  B) 📋 Show all findings — I'll decide what to fix
  C) ⏭ Skip fixes, proceed to PR as-is
  D) ⏹ Stop — I'll fix manually
```

The counts come from the ingested package, not from re-reading the prose:

```bash
keryx review status <review-id-or-path>
```

**Mapping:**
- A → proceed to the FIX step (2.7)
- B → display all findings grouped by file, then re-ask A/C/D
- C → skip FIX, go to VERIFY (2.8) — allowed only when 0 blockers; refuse while a blocker stands
- D → close the open steps with a reason (2.1) and go to Phase 3

Whichever branch is taken, **every finding still needs a disposition** before the
review can be completed — see 2.7. "Nobody chose to fix it" is `dismissed-wont-fix`
with evidence, not silence.

**Auto-proceed** (skip this question) when:
- 0 findings → go straight to VERIFY (2.8)
- only `minor`/`info` findings → skip FIX, go to VERIFY (2.8)
- `auto_create_pr: true` → auto-select A

### 2.7 Step: FIX (conditional)

Only runs if NEEDS_FIX is true. Default max: **3 iterations** (`max_review_iterations`).

Three is the shared round bound: `task-implementer`, `flow-orchestrator` and
this skill all use it. *"The first three to four repair iterations account for
most achievable gains"* ([arXiv:2607.05197](https://arxiv.org/abs/2607.05197));
correctness falls **0.820 -> 0.673** across two forced revisions while
cumulative ever-correct is **0.847**
([arXiv:2607.24604](https://arxiv.org/abs/2607.24604)). Aider hardcodes
`max_reflections = 3`; OpenHands' critic uses 3.

The bound is a ceiling, not a target. Repetition ends the loop earlier and
**regardless of remaining iterations** — a counter cannot tell "converging
slowly" from "stuck", and an agent emitting the identical failing output three
times spends the whole budget before anything notices.

**A finding leaves this loop by being dispositioned, never by being absent.** The
previous version of this section recomputed "unresolved" as whatever the next round
still reported — so a finding the next reviewer simply did not look at was recorded as
fixed. That is absence-as-evidence, and the completion gate refuses it.

```
UNRESOLVED_FINDINGS = all blocker + major findings from step 2.6
PREVIOUS_REVIEW_OUTPUT = <the ingested report from step 2.6>

FOR iteration in [1, 2, 3]:
  IF NOT NEEDS_FIX: BREAK

  keryx job step <job-name> fix --status in-progress     # increments metrics.steps[].retries

  1. Group UNRESOLVED_FINDINGS by file
  2. Construct fix prompt — MUST include unresolved findings from previous attempt:

     task_type: "fix"
     findings: <UNRESOLVED_FINDINGS, in the canonical finding shape>
     iteration: <N>
     previously_unresolved: <findings that were in UNRESOLVED_FINDINGS last iteration but still present>
         → Prefix: "These specific findings were NOT fixed in iteration <N-1>: [list]"

  3. Launch task-implementer with the fix prompt (subagent_type: "general-purpose"),
     on the model `keryx review tier --fix-attempt <N> --findings <n> --json` computes
  4. Run the sanity check (step 2.5.2 logic) — verify commits were made
  5. Run the next managed round — the FULL 2.6.1 sequence, not a bare re-dispatch:
       keryx review budget  --spent <usd> --outstanding <n>
       keryx review start   --target branch --ref <feature-branch> --head <new-head>
       keryx review comments collect --repo <r> --pr <n> --sha <new-head> --round <N+1> --out <file>
       keryx review scope        --ref "$BASE_SHA" --json > scope.json
       keryx review blast-radius --ref "$BASE_SHA" --previous blast-radius.json --json > blast-radius.json
       <dispatch review-orchestrator with is_fix_round: true>
       keryx review ingest  --report <new-report> --ref <feature-branch> --head <new-head> \
                            --scope scope.json --blast-radius blast-radius.json \
                            --verifications <file> --refuted <file> --outstanding <n>
  6. Recompute NEEDS_FIX from the ingested findings
  7. Record what became of each finding raised in the PREVIOUS round — every one of
     them, before the next iteration starts:

       keryx review complete <previous-review-id-or-path> \
         --finding F-001 --disposition acted-on --evidence "fixed in <commit-sha>" \
         --finding F-002 --disposition dismissed-incorrect --evidence "<what was run, what it showed>" \
         --finding F-003 --disposition dismissed-out-of-scope --evidence "<decision, where written>"

     States: unknown, acted-on, dismissed-incorrect, dismissed-wont-fix,
     dismissed-out-of-scope, dismissed-deprioritised. Everything except `unknown`
     must cite where the outcome is written down. A recorded state and its citation
     cannot be overwritten by a later close — record a correction as a new round.
     Closing with no dispositions leaves every finding reading `unknown`, which means
     "nobody wrote down what happened".
  8. UNRESOLVED_FINDINGS = the blocker + major findings of the NEW round that are
     still without a terminal disposition

  9. STUCK CHECK — runs before the next iteration and ignores the budget:
     IF any finding identity is in UNRESOLVED_FINDINGS for the SECOND iteration
        OR the new review output is identical to PREVIOUS_REVIEW_OUTPUT
     THEN log "stuck: <what repeated>" and BREAK, even with iterations left.
     Identity is the finding's dedupe_key when it has one, otherwise
     reviewer + file + symbol + problem — never the display id, which is
     per-report and would fire on every second iteration whatever happened.

     Detection is also available from the durable record rather than this
     session's memory, which is the version that survives a restart:
       keryx review loop --flow <flow-id>
     It escalates with a non-zero exit on a recurring finding or two identical
     consecutive rounds, regardless of the remaining budget.
 10. PREVIOUS_REVIEW_OUTPUT = the new ingested report

  keryx job step <job-name> fix --status completed

AFTER THE LAST ROUND ONLY — answer every inbound PR comment, once:
  keryx review comments reply --repo <owner/repo> --pr <n> --outcomes <file> \
                             --review <review-id> --sha <head-sha> --final [--flow-link <url>]

IF still NEEDS_FIX after max iterations, or the stuck check broke the loop:
  Log "Unresolved after <N> iterations" with finding list, and say WHICH of the
  two ended it — a budget exhausted and a loop detected call for different next
  steps. Give every surviving finding a disposition (dismissed-wont-fix or
  dismissed-deprioritised, with evidence) rather than leaving it `unknown`
  → continue to VERIFY (2.8)
```

`comments reply` **refuses without `--final`**: replying per round turns one review
thread into six, and a reply written mid-loop states an intention rather than an
outcome. Each reply is cut in code to 2 sentences and 600 characters, threaded where
GitHub gives a thread, capped at 30 with one summary comment for the remainder.
`--dry-run` rehearses the whole pass without posting.

**Fix prompt escalation pattern:**
- Iteration 1: "Fix these findings: [list]"
- Iteration 2: "These findings were NOT fixed in iteration 1: [subset]. Fix them now."
- Iteration 3: "FINAL attempt. These findings remain after 2 fix passes: [subset]. This is the last fix iteration." 

### 2.8 Step: VERIFY (code-verifier)

Dispatch `code-verifier` as a sub-agent. This is the quality gate; there is no separate
`CHECKS` step, and nothing in this document jumps to one.

```
Task({
  description: "Quality gate: <job-name>",
  subagent_type: "general-purpose",
  prompt: |
    You are code-verifier. Load skill: skills/gdskills/orchestration/code-verifier/SKILL.md

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
  → Log findings as informational in the job report

IF VERIFICATION_RESULT.gate == "FAIL":
  → Extract blocker/major findings
  → Check whether the fix step has already run:
      keryx job status <job-name> --json     # retries["fix"] is the recorded count
    - If it has not → run the fix step (2.7) with these findings
    - If `retries["fix"]` has reached 3 → escalate to the user and go to report.
      Three is the bound, and it is the same three everywhere in this skill.
```

**Document result:** write the verification report, then record it:

```bash
keryx job document <job-name> --type verification-report --file <path/to/verification-report.md>
keryx job step <job-name> verify --status completed --reason "gate: <PASS|PASS_WITH_WARNINGS|FAIL>"
```

### 2.8.1 Step: VERIFY-POST-FIX (code-verifier, conditional)

After fix iterations, dispatch `code-verifier` again with identical parameters.

```
IF fix ran:
  keryx job step <job-name> verify-post-fix --status in-progress
  Dispatch code-verifier (same params as step 2.8)
  IF gate still FAIL:
    Log "Verification failed after fix" → go to report with a warning
  IF gate PASS:
    Proceed to report
  keryx job document <job-name> --type verification-report --file <path/to/verification-post-fix.md>
  keryx job step <job-name> verify-post-fix --status completed --reason "gate: <status>"

IF fix did not run:
  keryx job step <job-name> verify-post-fix --status skipped --reason "no fix round was needed"
```

### 2.8.2 Step: PERF-CHECK (optional)

Auto-trigger `perf-check` when frontend/bundle files were modified:

```
IF any modified file matches: *.tsx, *.jsx, *.css, *.scss, webpack.*, vite.*, next.config.*
  AND project has build output (dist/, build/, .next/)
  THEN:
    Dispatch perf-check --bundle
    Add findings to report (informational, not blocking)
```

Skip if no frontend files changed or no build output exists. Results are advisory — they don't block the PR. Either way the step is closed on the record:

```bash
keryx job step <job-name> perf-check --status completed|skipped --reason "<result or why it did not run>"
```

### 2.8.3 Step: SKILL LEARNING (conditional)

Close the self-learning loop (see `rules/core/skill-lifecycle.mdc`). Collect the
learning signals produced upstream:
- `skill_drift` fields from each task-implementer result (`stale:`/`missing:`).
- the `## Skill Learning` block from `review-orchestrator`.

```
IF no skill_drift and Skill Learning == none:
  → skip this step (log "no skill drift")

ELSE for each flagged project-skill:
  1. Dispatch a subagent to build the learning proposal:
     - Model: COMPUTED, not chosen — run
         keryx review tier --findings 1 --diff-lines 0 --json
       and paste the `model` block into the dispatch. The command names no model:
       it ranks what the provider reports at runtime, and when it cannot rank
       anything it prints `inherit: true`, which means the dispatch runs on the
       session model. See rules/core/model-selection.mdc for what the tiers mean.
     - Command: keryx skills learn --from-review <review-report-path> \
                  --skill <module>/<skill>
       (or --from-test / --from-failure when the signal came from verification)
     - The subagent returns the proposal path. It does NOT apply.
  2. The orchestrator (flagship) reads the proposal and either:
     - keryx skills learn apply <proposal.json>   (accept), or
     - discards it and notes why in the report.
```

Never apply a proposal unread, and never run `learn` in a hook. Record applied
skill updates in the Job Report under "Skill Updates".

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
- **Review Rounds:** <N> (managed records: <review-id list>)
- **Final Status:** <READY FOR PR | HAS WARNINGS | HAS ISSUES | ANALYSIS ONLY>

## Analysis
<analysis summary>

## Tasks
### task-1: <Name>
- **Status:** success
- **Files:** <list>
- **Commits:** <hashes>

## Review Results
Round <n> — `.metaproject/reviews/<review-id>/`
| Reviewer | blocker | major | minor | info |
|---|---|---|---|---|
| review-logic | <N> | <N> | <N> | <N> |
| … | | | | |

Verification: <V> claims recorded, <R> findings refuted, <U> unverified.
Reviewers excluded by `keryx review stack`: <name — reason>.
Inbound PR comments: <C> collected, <A> answered in the final reply pass.

## Unresolved Issues
- [ ] <file>:<line> — <message> (from <reviewer>, disposition `<state>`, evidence `<ref>`)

## Final Checks
- Lint: PASS
- Type Check: PASS
- Tests: 42 passed, 0 failed

## Skill Updates
- `<module>/<skill>` v1.2.0 → v1.3.0 (from review F-012; applied) | none

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

Then record the step, with the PR on the record:

```bash
keryx job step <job-name> pr --status completed --reason "<PR URL>"
```

If the job had review findings but no PR until now, ask the 2.6.2 publication
question here — this is the point at which it can be acted on.

---

## Phase 3: COMPLETION

### 3.1 Close the Job Package

```bash
keryx job complete <job-name>
```

This is a **gate, not a formality.** It refuses while any step is still open or
`failed`, and the refusal names them:

```
Cannot complete job <name> — 12/15 steps terminal (not terminal: perf-check, deploy; failed: fix).
Close each with: keryx job step <name> <step-id> --status completed|skipped [--reason "<why>"]
```

So close every remaining step first, with a reason that says what happened:

```bash
keryx job step <job-name> deploy --status skipped --reason "user declined the staging deploy"
```

A job that ended badly is closed the same way — each unfinished step recorded as
`skipped` with the reason it stopped. There is no "aborted" status to set: what
happened is in the step statuses and in `journal.md`, which is a record, not a label.

On success the package moves to `phase: COMPLETION` and `plan.current_step` is
cleared, so 0.0 will no longer offer it for resumption.

### 3.2 Present Results

Tell user:
1. What was accomplished (summary)
2. Where the package is: `.metaproject/jobs/<job-name>/`
3. PR URL (if created)
4. Step durations and retries, read from the package
5. Any unresolved issues, each with its recorded disposition

```
✅ Job completed successfully.

  Package:   <JOBS_ROOT>/<job-name>/
  Branch:    feature/<slug> (worktree: <path>)
  PR:        <URL or "not created">
  Review:    <N> managed rounds, .metaproject/reviews/<review-id>/
  Steps:     <done>/<total>, retries <sum>

  keryx job status <job-name>   — the step list, retries and recorded documents
  <JOBS_ROOT>/<job-name>/journal.md — every recorded event, in order
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

1. **Keep the existing package** — its completed steps (analyze, context, report) stay
   completed and stay on the record.
2. **Create the implementation package** and run it as an `implement` job:

   ```bash
   keryx job init --name <analysis-job-name>-impl --intent implement --project <project_dir>
   ```

   `keryx job` does not rewrite a package's plan after `init`, and this skill does not
   ask it to: a plan that could be rewritten in place is a plan whose recorded history
   cannot be trusted. The two packages are linked by naming and by a journal line:

   ```bash
   keryx job step <analysis-job-name> proposal --status completed \
     --reason "user accepted; implementation continues in job <analysis-job-name>-impl"
   ```
3. **Complete the analysis job** (`keryx job complete <analysis-job-name>`) once its
   steps are closed, so it stops being offered for resumption in 0.0.
4. **Continue execution** from Phase 1.3 of the new package.

This is the core of dynamic planning — the work grows based on user decisions, and each
stage keeps its own auditable package rather than one package quietly changing shape.

---

## State Management

There are two kinds of state, and confusing them is how a job loses its record.

**Persisted — written by `keryx job`, survives the session.** This is exactly what
`state.schema.json` declares and exactly what the six commands write. The root carries
`additionalProperties: false`, so a field that is not on this list cannot be stored:

```
state.json:
  phase:      CONTEXT | PLAN | EXECUTION | COMPLETION      (job init, job step, job complete)
  intent:     implement | analyze | review | custom        (job init)
  job_name:   <slug matching ^[a-z0-9-]+$>                 (job init)
  create_pr:  <bool>
  context:
    project_dir:  <path>                                   (job init --project)
    base_branch:  <string>
    issue:        { number, title, url, type }
  plan:
    steps: [{ id, type, agent, depends, conditional,
              status: pending|in_progress|completed|skipped|failed }]   (job step)
    current_step: <first step that is not terminal>        (maintained by job step)
  documentation:
    job_path:          .metaproject/jobs/<job-name>
    documents_created: [<file name per recorded document>] (job document)
  metrics:
    steps: [{ step_id, status, started_at, completed_at, duration_ms, retries }]  (job step)
  jobs_root:  .metaproject/jobs
  updated_at: <ISO 8601, stamped on every write>
```

`journal.md` sits beside it: append-only, one timestamped line per event, with the
`--reason` text where one was given. Between the two, "what happened to this job" is
answerable without this session.

**In-session — held by the orchestrator for this run, and NOT persisted.** Say it in
the dispatch prompt, or it does not reach the sub-agent:

```
branch:      { name, worktree_path, merge_base, package_manager, run_command }
analysis:    { total_tasks, tasks, dependency_order }
context_doc: the path to the job's ai/context.md
review:      the current round's findings — the durable copy is the managed review
             package, not this
```

Five fields this skill used to claim it recorded — `sanity_check`,
`convention_reviewers`, `publication_plan.mode`, `pending_pr_review_report_comment`,
`pending_review_ai_artifact` — are **not** persisted and are not in the schema. Nor is
a `paused` or `timeout` status. Nothing writes them, so nothing claims them: what would
have gone into them goes into a `--reason` on the journal, or into the 2.9 report.

---

## state.json Specification

**Location:** `.metaproject/jobs/<job-name>/state.json`

**Schema:** `skills/gdskills/orchestration/job-orchestrator/state.schema.json`, registered
as the contract `job-orchestrator-state`.

**Who writes it:** `keryx job`, and nothing else. Every write is validated against the
registered contract first and a non-conforming state is **refused**, not written:

```
Refusing to write .metaproject/jobs/<name>/state.json — it does not validate against
job-orchestrator-state:
  - /plan/steps/0/status: must be one of pending, in_progress, completed, skipped, failed
```

**Do not hand-write it.** No `cat > state.json`, no `jq` edit, no sub-agent writing it
directly. A hand-written state bypasses the validation and the journal, which is how a
package ends up describing a job that did not happen.

Validate any state file against the contract directly if you need to:

```bash
keryx skills contracts validate .metaproject/jobs/<job-name>/state.json --schema job-orchestrator-state
```

**When it is written:**

| Command | What it changes |
|---|---|
| `keryx job init` | creates the package, the plan, `phase: PLAN` |
| `keryx job step` | a step's status, `plan.current_step`, `metrics.steps[]` (including `retries`), `phase: EXECUTION` |
| `keryx job document` | `documentation.documents_created`, and copies the file in |
| `keryx job complete` | `phase: COMPLETION`, clears `plan.current_step` — refused unless every step is terminal |

**Job resumption (Phase 0.0):** `keryx job list --json` finds packages whose `phase` is
not `COMPLETION`; `keryx job status <name> --json` names `next_step` — the first step
that is neither `completed` nor `skipped`. Both answers are computed from the file, so
a resumed session does not depend on remembering where it was.

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
- Record it: `keryx job step <job-name> <step-id> --status completed`.
- Continue to next step in the plan.

**`STATUS: DONE_WITH_CONCERNS`**
- Accept result as complete.
- Read the `## Concerns for orchestrator` section carefully.
- Decide: (a) log concern and continue, (b) surface concern to user at next checkpoint, or (c) re-dispatch with adjusted scope if the concern affects correctness.
- Do NOT silently discard concerns. Put them on the record and include them in the final report:
  `keryx job step <job-name> <step-id> --status completed --reason "<the concern>"`
  — the reason lands in `journal.md`, so the concern outlives the session.

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
  subagent_type: "general-purpose",
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

`subagent_type` is **`general-purpose`**. That is the dispatcher's own name for a
general agent; `"general"` is not a value any dispatcher accepts, and a dispatch
carrying it does not run.

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
| `skip_confirmation` | `true` | `true` only | Sub-agents run without per-dispatch confirmation. `{"const": true}` in the input contract. Does **not** cover the 0.4 operator gate — that one is `plan_approval`. |
| `base_branch` | auto-detect | any | Base branch (auto-detect from repo default, or ask user). No default in the contract. |
| `max_review_iterations` | `3` | 1-3 | Max review → fix iterations. Three everywhere: this table, 2.7, and the input contract's `maximum` and `default`. |
| `create_pr` | `true` | true/false | Whether to propose PR at the end |
| `auto_create_pr` | `false` | true/false | Auto-create PR without asking |
| `review_flags` | auto-detect | `review-orchestrator` flags | Reviewer selection passed to `review-orchestrator` (e.g. `--backend --security`). Unset means auto-detect from the diff. |
| `convention_reviewers` | `"ask"` | `"ask"` / `"all"` / `"none"` / skill names | Optional convention reviewers to include in review |
| `verification_mode` | `annotate` | `off`/`annotate`/`filter` | Passed to `review-orchestrator` and to `review ingest --verification-mode` |
| `run_final_checks` | `true` | true/false | Run lint/type-check/test |
| `run_interview` | `true` | true/false | Run interview skill in Phase 0 |
| `dry_run` | `false` | true/false | Plan-only mode: full Phase 0+1, no agent dispatch or git ops |
| `plan_approval` | `true` | true/false | Show agent plan and ask approve/adjust before execution (1.3) |
| `run_test_gen` | `true` | true/false | Auto-run test-gen if implementer skips tests |
| `run_security_audit` | `true` | true/false | Auto-run security-audit if auth/API/DB files touched |
| `run_perf_check` | `true` | true/false | Auto-run perf-check if frontend/bundle files changed |
| `run_changelog` | `true` | true/false | Auto-generate changelog entry and include in PR description |
| `publish_pr_review_report` | `ask` | `ask`/`comment`/`comment-and-ai-artifact`/`none` | Whether to publish a concise PR review comment and optional detailed AI markdown artifact |
| `run_deploy` | `ask` | `ask`/`true`/`false` | Post-PR deploy: ask user (ask), always deploy (true), never (false) |

`review_mode` is gone. It defaulted to `"code-review"` — a skill that is not bundled
and not catalogued — and its `"individual"` alternative named the legacy hand-dispatch
path 2.6 replaced. Reviewer selection is `review_flags`, and the reviewers are
`review-orchestrator`'s.

## Dry-Run Mode

When `dry_run: true` is set (or `--dry-run` is passed):

1. **Phase 0** runs fully — context collection, interviewer (if applicable), summary + confirm
2. **Phase 1** runs fully — plan is built and displayed with step tree
3. **Phase 2 is skipped entirely** — no sub-agents dispatched, no git operations
4. **Output:** Full plan tree with agent names, input data shapes, dependencies:

```
Dry-run plan for: issue-4141--pipeline-validation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 1: analyze          [issue-analyzer]           → input: issue #4141
Step 2: context          [context-collector]        → input: analysis result, project_dir
Step 3: prepare          [orchestrator]             → creates: feature/pipeline-validation worktree
Step 4: tests-creator    [tests-creator × 3]        → RED stubs, one per task
Step 5: implement        [task-implementer × 3]     → wave-parallel, 3 tasks
Step 6: sanity-check     [orchestrator]             → verifies commits exist
Step 7: verify           [code-verifier]            → lint + type-check + test + imports
Step 8: review           [review-orchestrator]      → managed round, ingested
Step 9: security         [security-audit]           → conditional: auth/API/DB/env files
Step 10: fix             [task-implementer]         → conditional: if NEEDS_FIX
Step 11: verify-post-fix [code-verifier]            → conditional: after fix
Step 12: perf-check      [perf-check]               → conditional: frontend/bundle files
Step 13: report          [orchestrator]             → aggregates all results
Step 14: pr              [orchestrator + gh CLI]    → conditional: if create_pr
Step 15: deploy          [deploy]                   → conditional: if user asks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Estimated sub-agent calls: 11-14 (varies with tasks and review findings)
No changes will be made. Use without --dry-run to execute.
```

5. Ask user: "Execute this plan? (yes / adjust / abort)"

## Budget Guards

**There are no timeouts, because this execution model has no clock.** This skill runs
as a model inside a turn-based session: it cannot observe wall-clock time passing, it
cannot kill a sub-agent mid-flight, and it has no persisted start time to measure
against. A `step_timeout_ms` that "kills the agent if exceeded" was a guard nothing
could ever enforce, and a job could not end with a `timeout` status because no such
status exists in `state.schema.json`.

What actually bounds this orchestrator:

| Guard | Bound | Where it is enforced |
|-------|-------|----------------------|
| review → fix rounds | 3 | 2.7, and `max_review_iterations` (`maximum: 3`) in the input contract |
| repetition, whatever the count says | first repeat | the STUCK CHECK in 2.7, and `keryx review loop` against the durable record |
| retries per step | recorded, not guessed | `metrics.steps[].retries`, incremented by `keryx job step --status in-progress` and read back with `keryx job status --json` |
| reviewer fan-out | 4 in flight | `keryx review budget --outstanding <n>` before every dispatch (2.6.1) |
| spend | 3 USD by default | `keryx review budget --spent <usd>` — a non-zero exit means stop and ask |

Each of these is a number some command reads or writes. A guard no command can
observe is not a guard; this section lists only observable ones.

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
| `retryable` | Transient failure — malformed output, an unusable reply, a command that failed on something transient | Auto-retry up to 2× with **identical prompt**, re-opening the step each time so `retries` counts it. After 2 failures → escalate to `recoverable` |
| `recoverable` | Partial success or skippable failure | Ask user with specific "continue from here / skip step / abort" options |

### Error Table

| Error | Class | Action |
|-------|-------|--------|
| Issue not found (404) | `terminal` | ABORT — issue-analyzer reports 404 |
| Analysis returns 0 tasks | `recoverable` | Try smart fallback: (1) re-read issue with broader scope, (2) ask user to clarify, (3) if still 0 → ABORT |
| Branch/worktree creation fails | `terminal` | ABORT — report git error. NEVER fall back to `git checkout -b` |
| Interviewer `ready_to_proceed: false` | `terminal` | STOP — tell user which blockers remain |
| Sub-agent returns malformed JSON | `retryable` | Retry with: "Output was malformed. Fix: [errors]. Try again." (max 2×) |
| Sub-agent returns nothing usable | `retryable` | Re-open the step (`job step --status in-progress`, which counts the retry) and re-dispatch the identical prompt (max 2×) |
| Task implementation fails | `recoverable` | Ask: "Step failed. Continue remaining tasks / skip this task / abort?" |
| `keryx job` refuses a write | `terminal` | The message names the field that failed validation. Fix the input; do NOT hand-write `state.json` to route around it. |
| `keryx job complete` refuses | `recoverable` | It names the open and failed steps. Close each with `job step --status completed\|skipped --reason "<why>"`. |
| `keryx review ingest` refuses a scope-B finding | `terminal` for that round | Recompute `keryx review blast-radius --json` and re-ingest with `--blast-radius`. The round is not recordable until the set is supplied. |
| All reviewers fail | `recoverable` | Record the round as failed with a reason, add a warning to the report, continue to VERIFY (2.8) |
| Fix loop exceeds max_review_iterations | `recoverable` | Disposition every surviving finding, log which ended the loop, continue to VERIFY (2.8) |
| Final checks fail | `recoverable` | Include in report, still propose PR (user decides) |
| gh CLI not available | `recoverable` | Print PR data, user creates manually. `keryx review comments` needs it too — say so rather than reporting `0 outstanding`. |

### Retry Protocol (for `retryable` errors)

```
attempt 1: keryx job step <job-name> <step-id> --status in-progress
           run step normally
→ failure: classify error
→ if retryable: keryx job step <job-name> <step-id> --status in-progress   # retries += 1
               retry with the EXACT same prompt + "Fix these errors: [list]"
→ if fails again: escalate to recoverable → ask user
→ if success: keryx job step <job-name> <step-id> --status completed
```

**Critical:** on retry, re-send the **same prompt** — hold it for the duration of the
step and re-send it verbatim. Never re-derive it; re-derivation causes drift.

The prompt itself is **not** persisted: `keryx job` writes no `step.prompt` and no
prompt size, so do not instruct a resuming session to read one. What *is* persisted is
that the attempt happened — `metrics.steps[].retries`, incremented every time the step
re-enters `in_progress`, and the `--reason` line in `journal.md`. A resumed session
therefore knows how many attempts a step has had, which is the fact the retry budget
needs, and reconstructs the prompt from the plan and the analysis exactly as the first
attempt did.

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
├─ ⏳ Verify
├─ ⏳ Review
├─ ⏳ Fix (if needed)
└─ ⏳ PR
```

**Notify at every step boundary** — before dispatching and after recording the result.
Those are the moments this skill actually regains control, so they are the only moments
it can say anything; a "notify every 30 seconds" rule would need a timer nothing here
has. `keryx job status <job-name>` renders the same tree from the package, which is
what to show a user who asks mid-run.

**If notification tools are unavailable** (no MCP, no Telegram): fall back to inline text output between steps.

---

## Rules of Engagement

Everything this orchestrator does is described once, with its reason, in the
section that owns it. This section is not a second copy of that. It carries the
three rules stated nowhere else, and the four whose cost, when you get them
wrong, cannot be undone by trying again.

### Stated only here

- **Do not ask the user anything between Phase 0 and completion.** Two
  exceptions: a critical failure, and a decision to extend the plan (analyze →
  implement). Everything else was settled in Phase 0, or is settled by the
  package rather than by asking.
- **Do not push the branch until the user confirms**, unless `auto_create_pr` is
  set. A push is visible to everyone watching the repository, and there is no
  version of un-pushing it that they do not see.
- **Say where the job package is when the job ends.** It is the only durable
  record of the run, and a user who cannot find it is left with nothing to read.

### Unrecoverable if wrong

- **Branch with `git worktree add`** — never `git checkout -b` or
  `git switch -c`. Those switch the main working directory out from under the
  user's own session, mid-run.
- **Run every later command in the worktree directory**, not the project root.
  A build, test or commit that lands in the wrong tree is attributed to work
  nobody did.
- **`keryx job` is the only writer of `state.json`**, this orchestrator
  included. It validates each write against the `job-orchestrator-state`
  contract; a hand-written file satisfies no contract, and the next session
  resumes into a state that never existed.
- **Ask for the project directory in Phase 0.** There is no default. A wrong
  guess writes a job package into somebody else's repository.

---

## Red Flags

The two callouts above ("the result looks fine without a status line", "the
subagent can read `state.json` itself") are the two this orchestrator gets wrong
most often. These are the rest. Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "The worker returned `STATUS: DONE`, so the task is verified." | `DONE` is the worker's report that it finished its own task, self-check included. The gate is step 2.8: `code-verifier` over the wave's whole diff. A task can be individually DONE and still break the build the moment it meets the other tasks in the wave. |
| "The user is right here — I'll just ask which option they prefer." | Between Phase 0 and completion there are exactly two reasons to ask: a critical failure, and extending the plan from analyze to implement. Everything else was settled in Phase 0. A mid-run question turns an autonomous run into a session the user has to babysit. |
| "`git checkout -b` is simpler than setting up a worktree for this one." | It switches the user's own working directory out from under their live session, mid-run. This is in the "unrecoverable if wrong" list: `git worktree add`, always, and every later command runs inside that worktree. |
| "I know this step completed — recording it through `keryx job` is bookkeeping." | The package IS the state. `keryx job` is the only writer of `state.json`, and a resumed session knows only what it reads there. A step held in this session's head did not happen as far as the next session is concerned. |
| "The subagent will work better with the full analysis JSON, so I'll paste it in." | The minimality principle: each subagent type gets its scoped slice. Extra context does not add capability; it fills the window with material the worker must first decide is irrelevant, and raises the odds it invents something from it. |
| "This step failed twice — one more attempt with a sharper prompt should do it." | The retry protocol is one retry with the EXACT same prompt plus the error list; a second failure escalates to the user. Re-deriving the prompt causes drift, and the drifted attempt no longer tests the same thing. |
| "The branch is ready and the PR is the obvious next step, so I'll push." | Do not push until the user confirms, unless `auto_create_pr` is set. A push is visible to everyone watching the repository, and there is no un-push they will not see. |
| "The job finished cleanly, so the report can be short." | Say where the job package is, every time. It is the only durable record of the run; a user who cannot find it is left with a summary and nothing to check it against. |

---

## Configurable Jobs Root

`JOBS_ROOT` in this document is shorthand for **`.metaproject/jobs`, relative to the
project directory** — and that is the only value it takes. `keryx job` resolves it from
the working directory and records it in `state.json → jobs_root`; there is no
environment variable and no override, so do not tell a sub-agent to look one up.

```bash
JOBS_ROOT=".metaproject/jobs"
```

The project directory is the one collected in Phase 0.2 and passed as
`keryx job init --project <path>`. Run `keryx job` commands from that directory, and
expand `<JOBS_ROOT>` to the literal path when writing a sub-agent prompt — a subagent
receives paths, it does not resolve them.

---

## Post-Mortem (for failed/aborted jobs)

When a job ends with a step recorded `failed`, or with unresolved blocker findings:

1. **Auto-generate post-mortem** document. The timeline is not recalled — it is read
   off `journal.md`, which `keryx job` timestamped as the job ran, and the retry counts
   come from `keryx job status <job-name> --json`:

```markdown
# Post-Mortem: <job-name>

## Timeline
(from .metaproject/jobs/<job-name>/journal.md — every line as recorded)
- <ISO timestamp> - created
- <ISO timestamp> - step: implement in-progress (retries 0)
- <ISO timestamp> - step: implement in-progress (retries 1)
- <ISO timestamp> - step: implement failed (retries 1) — <reason>

## What Went Wrong
- <Step name> failed with: <error class> — <error message>
- Recorded retries: <metrics.steps[].retries>
- Root cause hypothesis: <analysis>

## What Worked
- <N> tasks completed successfully
- Context collection was accurate

## Recommendations for Retry
- Fix <specific issue> before re-running
- Consider splitting task-3 into smaller subtasks
```

2. Save to `.metaproject/jobs/<job-name>/post-mortem.md`
3. Include in final user message: "Post-mortem saved to `.metaproject/jobs/<job-name>/post-mortem.md`"

There is no `aborted` or `timeout` job status to key this on and nothing writes one.
The trigger is what the package says: a `failed` step, or findings still without a
terminal disposition.

---

## Metrics Collection

`keryx job step` writes a metrics row per step. Nothing here is collected by hand.

**Written per step, into `state.json → metrics.steps[]`:**
```json
{
  "step_id": "implement",
  "status": "completed",
  "started_at": "2026-08-30T10:30:00.000Z",
  "completed_at": "2026-08-30T10:35:22.000Z",
  "duration_ms": 322000,
  "retries": 0
}
```

- `started_at` is stamped every time the step enters `in_progress`.
- `retries` counts attempts **beyond the first**: the first `--status in-progress`
  leaves it at 0 and every re-entry adds one. It is on disk, so a resumed session
  reads the real count instead of restarting at zero.
- `duration_ms` is `completed_at - started_at` for the last attempt.
- `total_tokens` is declared in the schema and **nothing writes it**. Do not report a
  token figure as if it came from the package; if you have one, say where it came from.

**Read it back:**
```bash
keryx job status <job-name> --json     # `retries` per step, plus phase and next_step
```

**Aggregated in the report:**
```markdown
## Metrics
| Step | Duration | Retries |
|------|----------|---------|
| Analyze | 45s | 0 |
| Context | 30s | 0 |
| Implement | 5m 22s | 1 |
| Review | 1m 10s | 0 |
| **Total** | **7m 47s** | **1** |
```

This data identifies which steps are bottlenecks and which ones needed a second attempt.

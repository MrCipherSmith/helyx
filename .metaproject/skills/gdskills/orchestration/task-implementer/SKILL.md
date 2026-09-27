---
name: task-implementer
model_tier: standard
description: "Use when implementing a single task out of an issue-analyzer breakdown end-to-end, or executing autonomous code changes from a JSON task object. NOT for: splitting an issue into that breakdown in the first place (use issue-analyzer)."
triggers:
  - "implement task"
  - "execute task"
  - "atomic task"
  - "Execute task scenario"
  - "Code this task"
  - "Run task-implementer"
  - "Implement issue task"
metadata:
  author: "MrCipherSmith"
  version: "1.3.1"
  category: "orchestration"
  agent_worthy: true
  compatible_harnesses: "claude,cursor,codex,zed,opencode"
license: "MIT"
---

# Task Implementer

## Purpose

Receives a single atomic task (JSON task object from `issue-analyzer`) and implements it end-to-end. Designed to run autonomously as a sub-agent — no user interaction required. Commits its changes to a shared feature branch managed by the orchestrator.

**Input:** JSON task object + workspace context (branch, codebase path, optional real issue number)
**Output:** JSON result object with implementation status, files modified, verification results

## When to Use

- Orchestrator dispatches a task from `issue-analyzer` decomposition
- Implementing a single atomic code change (new component, store change, API fix, etc.)
- Fixing review findings dispatched back by orchestrator (`task_type: "fix"`)

## Architecture: 6 Phases

```
Phase 1: RECEIVE    →  Parse task input, validate, set up context
Phase 2: RESEARCH   →  Deep-read target files, understand module patterns
Phase 3: PLAN       →  Decide implementation approach, list file changes
Phase 4: IMPLEMENT  →  Write code, tests, stories
Phase 5: VERIFY     →  Run lint, type-check, tests
Phase 6: REPORT     →  Write result file + emit compact STATUS response
```

---

## Workflow

```
Task Implementer Progress:
- [ ] Phase 1: Receive and parse task input
- [ ] Phase 2: Research target files and module patterns
- [ ] Phase 3: Plan implementation approach
- [ ] Phase 4: Implement code changes
- [ ] Phase 5: Verify (lint, type-check, test)
- [ ] Phase 6: Report results
```

### Phase 1: RECEIVE

Parse the incoming task and validate all required fields.

**1.1 Extract from JSON task object:**

```
TASK: (from JSON object passed by orchestrator)
  task_id:              string, e.g. "task-1"
  task_name:            string, e.g. "Add validation to form"
  task_type:            string: ui_component|store_logic|service_api|refactoring|fix|mixed
  complexity:           string: low|medium|high
  dependencies:         array of task_id strings this task reads from
  description:          string: what to implement
  target_files:         array of file path strings
  acceptance_criteria:  array of criterion strings
  context:              string: code context, types, signatures
  existing_tests:       array of file path strings (may be empty)
  existing_stories:     array of file path strings (may be empty)
  module_patterns:      string: how similar code is written in this module
  test_case_specs:      optional — provided by tests-creator (RED-phase test stubs already committed)
```

**1.2 Extract from workspace context:**

```
WORKSPACE:
  codebase_path:        absolute path to the repository
  branch:               feature branch to work on (already checked out by orchestrator)
  issue_number:         Optional real GitHub issue number; omit for description-based tasks
  issue_title:          issue title (for commit messages)
```

For a description-based task, omit `issue_number` and issue references in commit messages. Never substitute a flow ID or fabricate a GitHub issue. A supplied issue number must remain a positive integer.

**1.3 For fix tasks (dispatched from review loop):**

```
FIX_CONTEXT:
  review_feedback:      structured findings from reviewer (file, line, severity, message)
  original_task_ids:    the tasks that introduced the findings (array)
  iteration:            fix iteration number, 1..3 — the same repair bound as 5.4
```

**1.4 Validate the request against the contract:**

Write the request you were handed to a file and run:

```bash
keryx skills contracts validate <request.json> --schema task-implementer-input
```

Non-zero exit means the dispatch is malformed — ABORT and report `NEEDS_CONTEXT`
with the validator's own message. Do not repair the request yourself; the
orchestrator owns it.

The refusals are the contract's, not a checklist you run by eye
(`input-contract.schema.json`, registered in `src/gdskills/contracts.ts`):

| What is refused | Where the schema says so |
|---|---|
| Missing `task_id` / `task_name` / `task_type` / `description` / `target_files` / `acceptance_criteria` | `task.required` |
| `task_type` outside `ui_component\|store_logic\|service_api\|refactoring\|fix\|mixed` | `task.task_type.enum` |
| A `task_id` that is not `task-<n>` | `task.task_id.pattern` |
| Empty `target_files` or empty `acceptance_criteria` | `minItems: 1` on both |
| Missing `codebase_path` / `branch` | `workspace.required` |
| `skip_confirmation` anything but `true` | `automation.skip_confirmation.const` |
| `max_self_fix_attempts` above 3 | `automation.max_self_fix_attempts.maximum` |
| Any field the contract does not declare | `additionalProperties: false` |

The list above is a reading aid. The schema is the authority, and if the two
disagree the schema wins.

Two things a schema cannot check, because they are facts about the machine
rather than about the payload. Check them yourself and ABORT with
`STATUS: NEEDS_CONTEXT` on either:

```bash
test -d "<codebase_path>"                       # otherwise: codebase path not found
git -C "<codebase_path>" rev-parse --abbrev-ref HEAD   # must equal <branch>
```

**1.5 TDD Check (if `test_case_specs` is present):**

If the task object contains `test_case_specs` (provided by `tests-creator`):
1. Read each test file listed in `test_case_specs.test_files`
2. Run the tests using `test_case_specs.run_command` — confirm they FAIL
3. If tests pass already → report `DONE_WITH_CONCERNS` (tests may not be testing the right thing)
4. Note: **implementation goal is to make these tests GREEN** — do not rewrite or delete them

If `test_case_specs` is absent:
- The task was not pre-processed by `tests-creator`
- Write tests as part of Phase 4 (standard mode) following `tdd-workflow.mdc`

### Phase 2: RESEARCH

Deep-read the target files and surrounding module to understand patterns.

**2.0 Read job context (if available):**

If the orchestrator provided `JOB_NAME` and `CONTEXT_PATH`:
- Read `CONTEXT_PATH` (e.g., `<JOBS_ROOT>/<job-name>/ai/context.md`)
- Extract relevant sections: library docs, codebase patterns, conventions, best practices
- Use this context throughout Phase 2-4 to guide implementation decisions
- If the file does not exist, proceed without it — context is optional

**2.0b Verify the project-skill covering the target (see `rules/core/skill-lifecycle.mdc`):**

Before you rely on a project-skill's guidance, confirm it still matches the code:
- `keryx skills route <target_file>` — find the project-skill for this module/entity (if any).
- If one exists: `keryx skills verify <module>/<skill>` — classifies it `fresh | stale | needs-review | blocked`.
- If it is **not `fresh`**: do not follow it blindly. Verify each claim against the code you read in Phase 2, and note the drift in `notes` (Phase 6.1) so the orchestrator can trigger `skills learn`.
- If no skill exists for a non-trivial module you had to reverse-engineer, note that too — it's a candidate for `skills create`.

This step is read-only and inline; do not spawn a subagent for it.

**2.1 Read all target files:**
- Read each file from `target_files` in full
- If a file does not exist yet, note it as "new file to create"
- Read the `context` field for additional type/signature info

**2.2 Read existing tests and stories:**
- `existing_tests` and `existing_stories` are arrays and default to `[]`
  (`input-contract.schema.json`). Empty means none; the string `"none"` is not a
  legal value and a request carrying it is refused by 1.4
- Read each file listed in either array
- Understand existing test patterns (describe/it structure, mocks, fixtures) and, for every file in `existing_stories`, the story patterns it uses (`Meta`/`StoryObj` shape, how variants are declared, how callbacks are stubbed) — 4.4 builds on what you record here

**2.3 Read module neighbors:**
- List sibling files in the same directory as each target file
- Read 2-3 similar files to understand module patterns (naming, exports, structure)
- Pay attention to:
  - Import aliases used (e.g., `@components`, `@utils`)
  - Export patterns (named vs default)
  - TypeScript patterns (interfaces vs types, generics usage)
  - Component patterns (observer wrapping, props interface naming)
  - Store patterns (makeObservable(this), explicit decorators, private fields before public fields, thin public @action.bound UI actions, non-mutating public helpers, private API methods, runInAction inside private mutation blocks after await)

**2.4 Load relevant rules (from `module_patterns` or by detection):**

Based on what you're implementing, load and follow the relevant project rules.

**Always load (all task types):**
- `tdd-workflow.mdc` — red-green-refactor, STATUS: DONE requires passing tests
- `error-handling.mdc` — Result pattern, no silent failures
- `solid-principles.mdc` — SRP, OCP, DIP (load for any task that creates new classes/services)

**Load by task type:**

| Task Type | Additional Rules |
|-----------|---------------|
| `ui_component` | `code-style-patterns.mdc`, `frontend-assistant.mdc`, `storybook-guidelines.mdc` |
| `store_logic` | `code-style-patterns.mdc`, `mobx-store-template.mdc` |
| `service_api` | `code-style-patterns.mdc`, `nestjs-dto.mdc`, `api-contracts.mdc` |
| `fix` | Rules based on the files being fixed; always `error-handling.mdc` |
| `mixed` | All applicable rules above |

**Load when detected:**
- Database/ORM files touched → `database-patterns.mdc`
- Auth, API keys, user input → `security-baseline.mdc`
- `async`/`await` or queue code → `async-patterns.mdc`
- New architectural layers or modules → `clean-architecture.mdc`

Rules live at `.metaproject/rules/core/<rule>.mdc` on every harness — that is the
one tree `keryx init` installs and the one every build of this skill reads.

### Phase 3: PLAN

Decide the implementation approach. Self-validate — no orchestrator approval needed.

**3.1 Create change plan:**

For each file to modify or create, plan:
```
CHANGE_PLAN:
  - file: <path>
    action: create | modify | delete
    changes:
      - <description of what to add/change/remove>
      - <description of types/interfaces needed>
    rationale: <why this change is needed>
```

**3.2 Determine required outputs based on task_type:**

| Task Type | Code | Unit Test | Story | Screenshot Test |
|-----------|------|-----------|-------|-----------------|
| `ui_component` | Yes | Optional | Yes | Yes (if visual) |
| `store_logic` | Yes | Yes | No | No |
| `service_api` | Yes | Yes | No | No |
| `refactoring` | Yes | Verify existing pass | No | No |
| `fix` | Yes | Regression test | No | No |
| `mixed` | Yes | Per layer | Per UI component | Per visual change |

**3.3 Self-validation checklist:**
- [ ] All acceptance criteria are addressable with this plan
- [ ] No files outside the task's scope are being modified
- [ ] Changes follow the 3-layer architecture (Service → Store → Component)
- [ ] TypeScript types are planned (no `any`, proper interfaces)
- [ ] Imports use project path aliases
- [ ] Plan is consistent with `module_patterns`

### Phase 4: IMPLEMENT

Execute the change plan. Write production-quality code.

**4.0 TDD Mode Selection:**

- **TDD Mode** (when `test_case_specs` is present): tests already exist and are RED. Skip to writing implementation code that makes them GREEN. Do NOT write new tests — only write code that satisfies the existing stubs.
- **Standard Mode** (no `test_case_specs`): write tests first (per `tdd-workflow.mdc`), then implementation.

**4.1 Implementation order (Standard Mode):**
1. Types and interfaces first (shared types, DTOs)
2. Write failing tests for each acceptance criterion (RED)
3. Service/API layer implementation (make service tests GREEN)
4. Store/logic layer implementation (make store tests GREEN)
5. Component/UI layer implementation (make component tests GREEN)
6. Stories (if needed)

**4.2 Code standards (always follow):**
- TypeScript strict mode — no `any`, no `as` casts unless justified
- Use project path aliases for imports (`@components/...`, `@utils/...`)
- React components: `observer()` wrapping for MobX, named function components
- MobX stores: `makeObservable(this)` in constructor with explicit decorators, member order `private fields → public fields → constructor → public methods → private methods`, thin public `@action.bound` UI methods, non-mutating public helpers without actions, private API/IO methods, and `runInAction()` in private mutation blocks after every `await`
- Naming: PascalCase for components/types, camelCase for functions/variables, kebab-case for files
- Follow existing module patterns discovered in Phase 2

**4.3 Test standards:**
- Use the runner, selectors and structure Phase 2.2 found in this project's own tests — not a remembered stack. Arrange/Act/Assert; mock external dependencies, not internal module logic.

**4.4 Story standards:**
- Use the story patterns Phase 2.2 found (`Meta` + `StoryObj`, `args`-based variants, `fn()` callbacks); cover default state, edge cases and error states.

**4.5 Commit after implementation:**

When auto-commit is enabled, create a conventional commit with the changes. Stage explicit paths only — never `-A`/`--all`/`.` — and run every git command as `git -C "<codebase_path>"` (`rules/core/git-concurrency.mdc`). Include the `refs #<issue_number>` line below only when a positive real issue number was supplied; otherwise omit that entire line:
```bash
git -C "<codebase_path>" add <modified files, explicit paths>
git -C "<codebase_path>" commit -m "<type>(<scope>): <description>

refs #<issue_number>
task: <task_id>"
```

When auto-commit is disabled, do not commit. Report the exact list of files you
changed — nothing inferred — in the Phase 6 STATUS response and the result
file's `files_modified`/`files_created`/`files_deleted`; the orchestrator stages
and commits those exact paths at the task boundary (`rules/core/git-concurrency.mdc`,
"Reporting Back").

Commit type mapping:
| Task Type | Commit Type |
|-----------|-------------|
| `ui_component` | `feat` |
| `store_logic` | `feat` |
| `service_api` | `feat` |
| `refactoring` | `refactor` |
| `fix` | `fix` |
| `mixed` | `feat` (or `fix` if bug-related) |

### Phase 5: VERIFY

Run verification checks appropriate to the task type.

**5.1 Always run:**

```bash
keryx health run --changed --source eslint,typescript
```

Lint and type-check in one call, over the changed files only. Do NOT hard-code a
package manager and a script name: the project may not be an npm project, and
`src/health/sources/eslint.ts` and `src/health/sources/typescript.ts` resolve the
real invocation. The run writes a normalized report; `keryx health status` prints
it.

**5.2 Run if tests exist:**

```bash
keryx test run --changed --strict
```

`src/testing/service.ts:780` detects `bun` / `pnpm` / `yarn` / `npm` from the
lockfile and builds the argv from the project's own test script — the
if-chain you would otherwise write in shell, already written. `--strict` makes a
non-zero exit the signal; if tests were created or modified they must pass.

**5.3 Run if stories were created (optional, only if the script exists):**
```bash
<pm> run build-storybook   # <pm> is the package manager keryx test run detected
```

**5.4 Handle failures:**

| Failure | Action |
|---------|--------|
| Lint errors | Fix them in code, re-run `keryx health run --changed` |
| Type errors | Fix the type errors in code, re-commit |
| Test failures | Fix failing tests, re-commit |
| Story build failure | Fix story code, re-commit |

Maximum 3 self-fix attempts per verification step.

Three, and it is the same three `job-orchestrator` and `flow-orchestrator`
use: one round bound, not four. *"The first three to four repair iterations
account for most achievable gains"*
([arXiv:2607.05197](https://arxiv.org/abs/2607.05197)); correctness falls
**0.820 -> 0.673** across two forced revisions while cumulative ever-correct is
**0.847** ([arXiv:2607.24604](https://arxiv.org/abs/2607.24604)) — the agent
finds the fix and then destroys it. Aider hardcodes `max_reflections = 3`;
OpenHands' critic uses 3.

**Stop earlier on repetition, whatever the count says.** If an attempt produces
the same failure output as the previous attempt — the same failing test with the
same message, the same type error at the same site — do NOT spend the remaining
attempts. The counter cannot tell "converging slowly" from "stuck", and three
identical outputs cost the whole budget to learn what the second one already
said. Report the block instead, naming what repeated.

**ROLLBACK POLICY**: If implementation fatally fails (tests still failing after 3 attempts, or unresolvable compilation errors), restore ONLY the files this task changed — `git -C "<codebase_path>" checkout -- <your files>` for tracked ones, delete the untracked ones you created — then report the failure in Phase 6.

**Never run `git reset --hard`, `git clean`, or any unscoped revert.** You do not own the worktree. `job-orchestrator` dispatches implementers in PARALLEL WAVES sharing a single worktree, so an unscoped reset destroys a wave-mate's uncommitted work — work that is not yours, cannot be recovered, and whose loss is invisible to you because the other agent's failure surfaces somewhere else entirely. If you cannot identify which files are yours, leave the tree exactly as it is and say so in the report: a dirty tree is recoverable, a destroyed one is not.

**Same reasoning bans `git stash` and unscoped `git add`.** Never `git stash` — the stash stack is shared by every worktree, so even a scoped `push -- <file>` can be popped by another lane. Stage only the files this task changed (`git -C "<codebase_path>" add <path> <path>`), never `-A`/`--all`/`.`. Every git command runs as `git -C <this worktree's absolute path>`. See `rules/core/git-concurrency.mdc`.

**5.5 Re-commit fixes if any:**
When auto-commit is enabled, use the template below — explicit paths only, `git -C "<codebase_path>"` for every command (`rules/core/git-concurrency.mdc`). Include `refs #<issue_number>` only for a supplied positive real issue number; otherwise omit that entire line.
```bash
git -C "<codebase_path>" add <fixed files, explicit paths>
git -C "<codebase_path>" commit -m "fix(<scope>): resolve lint/type/test issues

refs #<issue_number>
task: <task_id>"
```

When auto-commit is disabled, do not commit; report the exact fixed-file list in
Phase 6 as in 4.5 — the orchestrator commits it at the task boundary.

### Phase 6: REPORT

Write the full result to a file, then emit a compact STATUS response to the orchestrator.

**6.1 Write result file (when `JOB_NAME` is provided):**

If the orchestrator provided `JOB_NAME` in the workspace context:
```bash
mkdir -p <JOBS_ROOT>/<JOB_NAME>/results
```
Write full JSON to `<JOBS_ROOT>/<JOB_NAME>/results/<task_id>.json`:
```json
{
  "task_id": "<task_id>",
  "task_name": "<task_name>",
  "task_type": "<task_type>",
  "status": "<success|partial|failed>",
  "description": "<what was implemented>",
  "files_modified": ["src/path/file.ts"],
  "files_created": ["src/path/newfile.ts"],
  "files_deleted": [],
  "commits": ["abc1234", "def5678"],
  "lint_result": "<pass|N errors: details>",
  "type_check_result": "<pass|N errors: details>",
  "test_result": "<pass|N passed, M failed: details|skipped>",
  "story_result": "<pass|build error: details|not applicable>",
  "acceptance_criteria_met": "<all|partial: list of unmet criteria|none>",
  "skill_drift": "<none | stale: <module>/<skill> — <what diverged> | missing: <module> should have a project-skill>",
  "noticed_not_touched": [{ "what": "<problem>", "where": "<path|symbol>" }],
  "assumptions": ["<what you assumed where the task did not say>"],
  "not_touched": [{ "path": "src/path/file.ts", "reason": "<why left alone>" }],
  "notes": "<any warnings, blockers, or additional context>"
}
```

Set `skill_drift` from Phase 2.0b: if the project-skill you used was not `fresh`, or the code you wrote diverged from what a skill documents, name the skill and the divergence. The orchestrator uses this to decide whether to trigger `skills learn` (do NOT run `learn` yourself — it is a mutating step the orchestrator dispatches; see `rules/core/skill-lifecycle.mdc`).

Three of those fields have a bar, and a field that collects noise trains the
reader to skim all three. Omit one rather than pad it. The trio is adapted (MIT)
from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) as contract fields rather than a free-text template; the bars below are ours.

- `assumptions` — what you assumed where the task was silent AND acted on. If
  the assumption being wrong would not change a line you wrote, it is a hedge,
  not an assumption; leave it out.
- `noticed_not_touched` — a problem in code you actually read, stated so a
  follow-up task could be written from it alone, with `where` it lives. Not a
  dumping ground for every smell seen in passing, and not style opinion.
- `not_touched` — of the files this task was aimed at (`target_files`), the ones
  absent from `files_modified`/`files_created`/`files_deleted`, each with why.
  It answers that one question and no other: a reader subtracts those lists and
  this one from `target_files`, and flags the remainder as an unexplained omission.

Then check the shape and record the file — two commands, both of which refuse
rather than warn:

```bash
keryx skills contracts validate <JOBS_ROOT>/<JOB_NAME>/results/<task_id>.json \
  --schema task-implementer-output
keryx job document <JOB_NAME> --type implementation-report \
  --file <JOBS_ROOT>/<JOB_NAME>/results/<task_id>.json
```

- `contracts validate` exits non-zero on a missing required field, a `status`
  outside `success|partial|failed`, a `task_id` that is not `task-<n>`, or any
  key the contract does not declare (`additionalProperties: false`). Fix the
  result and re-run; do not report a result the contract rejects.
- `job document` **refuses when the file does not exist** — "`--file` not found:
  … Write the document first, then record it" (`src/job/service.ts`) — and
  refuses a `--type` outside `analysis|implementation-report|review|verification-report`
  and a job name no package matches. On success it copies the result into the
  job package and appends it to `documentation.documents_created` in
  `state.json`, which is what makes "the result was recorded" a fact
  `keryx job status <JOB_NAME> --json` can be asked about instead of a sentence
  in this file.

One caveat, stated because it is real: the package holds ONE
`implementation-report.json` per job, so a later task in the same wave replaces
it. The per-task files under `results/` are the complete set; the recorded
document is the most recent.

If `JOB_NAME` is not provided, skip the file write and both commands — there is
no job package to record against.

The step's own status is the orchestrator's to write (`keryx job step <JOB_NAME>
<step-id> --status …`). Do not write it yourself: `src/job/plans.ts` makes
`implement` ONE step for a whole wave, so a single task cannot close it, and
`keryx job complete` refuses while any step is still open.

**6.2 Emit compact STATUS response:**

Return a compact STATUS response following `rules/core/subagent-status-protocol.md`.
**Do NOT include the full JSON block inline** — the orchestrator reads the result file when it needs details.
The inline response must contain only: STATUS line + Completed bullets + Files changed + Verification summary.

**Status classification:**
- `success` → `STATUS: DONE`, or `DONE_WITH_CONCERNS` when work that cleared the
  bar still carries something the orchestrator must know.
- `partial` → `STATUS: BLOCKED` — never `DONE_WITH_CONCERNS`. An unmet criterion,
  a failed gate or a gate that did not run breaks `rules/core/definition-of-done.mdc`,
  and `DONE_WITH_CONCERNS` reports on work that cleared that bar, never a lower
  one. The harness already reads it this way: `shouldEscalate`
  (`src/harness/child/escalation.ts`) escalates on any `acceptance[].status` of
  `not_met` whatever token arrived with it.
- `failed` → `STATUS: BLOCKED`

---

## Automation Settings

This skill is designed to run fully autonomously. The settings, their types,
their defaults and their bounds are declared in one place —
`input-contract.schema.json`, the `automation` object — and are checked by the
validation in Phase 1.4. To see them:

```bash
keryx skills contracts list          # names task-implementer-input and its file
```

They are deliberately not restated here. The table that used to sit in this spot
said `max_self_fix_attempts: 1-5` while Phase 5.4 says the maximum is 3, and a
second copy of a schema is how that happens.

---

## Error Handling

| Error | Action |
|-------|--------|
| Target file not found (expected to exist) | ABORT with error — dependency task may not have run |
| Branch mismatch | ABORT — orchestrator must fix branch |
| Lint fails after max attempts | Report as `partial`, include error details |
| Type-check fails after max attempts | Report as `partial`, include error details |
| Tests fail after max attempts | Report as `partial`, include failing test details |
| Git commit fails (pre-commit hook) | Fix lint-staged issues, retry commit |
| Acceptance criteria unclear | Implement best interpretation, note in report |

---

## Rules of Engagement

1. **DO NOT** ask the user any questions. All input comes from the task Scenario and workspace context.
2. **DO NOT** modify files outside the task's target scope unless absolutely necessary (e.g., shared type file).
3. **DO** follow the project's existing code patterns discovered in Phase 2.
4. **DO** write TypeScript-strict code — no `any`, no untyped functions.
5. **DO** use project path aliases (`@components`, `@utils`, etc.) for imports.
6. **DO** wrap React components with `observer()` when they access MobX stores.
7. **DO** use `runInAction()` after every `await` in MobX actions.
8. **DO** use conventional commit format when auto-commit is enabled. Reference only a supplied real issue number; omit the issue reference when absent.
9. **DO** verify your work before reporting.
10. **DO** make `STATUS: <TOKEN>` the first line of your final message, and put no
    JSON in the response body. The full JSON result is the file Phase 6.1 writes
    and records. `parseChildResult` throws on any first line that is not a
    canonical STATUS token.

---

## Red Flags — Stop and re-read this skill if you are thinking:

| Rationalization | Why it's wrong |
|---|---|
| "I'll implement first and verify acceptance criteria later" | Implementing without criteria means you might build the wrong thing correctly |
| "This is a small change, I don't need to read the context document" | Context documents exist because the task description alone is incomplete by design |
| "The task description is clear, I don't need to read related files first" | Module patterns and conventions only emerge from reading the actual files, not the description |
| "I'll report DONE and note the skipped tests as a concern" | Skipped verification is a failed verification — partial is not done |
| "I understand how this module works from previous tasks" | Each task targets a specific slice; read the files fresh to catch state that has changed |

**IRON LAW: READ ALL SPECIFIED FILES AND THE CONTEXT DOCUMENT BEFORE WRITING A SINGLE LINE OF CODE.**

---

## Reporting Results

**Rule:** `rules/core/subagent-status-protocol.md`

Every final response to the orchestrator MUST begin with `STATUS: <STATUS>`. The full JSON result object is written to a file in Phase 6.1 — the inline response contains only the compact STATUS format. No JSON in the response body.

### Iron Law

**STATUS LINE IS MANDATORY — ORCHESTRATOR CANNOT INTERPRET FREE TEXT**

### When to use each status

| Status | Use when |
|--------|----------|
| `DONE` | All acceptance criteria met, all verifications pass (or pass after self-fix) |
| `DONE_WITH_CONCERNS` | Task complete but: criteria required interpretation, workaround was used, unexpected discovery, verification passed with warnings |
| `BLOCKED` | Unresolvable blocker: required file missing after checking, unresolvable type errors after 3 attempts, branch conflict needing orchestrator action |
| `NEEDS_CONTEXT` | Task input is incomplete: `target_files` empty, `acceptance_criteria` uses undefined terms, `context` field missing required types |

### Correct final response format

```
STATUS: DONE

## Completed
- Added validation logic to PipelineStep component
- Created unit tests covering all 4 acceptance criteria
- Committed 2 conventional commits

## Files changed
- src/components/PipelineStep.tsx — added validateStep() method
- src/components/PipelineStep.test.tsx — new test file, 14 tests

## Verification
- lint: pass
- type-check: pass
- tests: 14 passed, 0 failed

Result file: <JOBS_ROOT>/<job-name>/results/task-1.json
```

For `DONE_WITH_CONCERNS`:

```
STATUS: DONE_WITH_CONCERNS

## Completed
- Implemented feature as described

## Files changed
- src/services/auth.ts — updated token refresh logic

## Verification
- lint: pass
- type-check: pass
- tests: 8 passed, 0 failed

## Concerns for orchestrator
- The acceptance criterion "support legacy tokens" was ambiguous — implemented support for both v1 and v2 token formats. If only v2 is needed, the v1 branch can be removed.

Result file: <JOBS_ROOT>/<job-name>/results/task-2.json
```

For `BLOCKED`:

```
STATUS: BLOCKED

## Reason
src/types/pipeline.ts does not exist and is listed as a dependency. Cannot implement the store layer without the type definitions.

## What I need from orchestrator
Run task-1 (which creates pipeline.ts) before re-dispatching this task, or provide the type definitions directly.

## Work completed so far
- (nothing — blocked before implementation could start)
```

See `rules/core/subagent-status-protocol.md` for the full format specification. Four statuses are yours as a skill worker; the fifth, `FAILED`, belongs to harness child workers and you must never emit it — report `BLOCKED` instead.

---

## Job Context Awareness

When dispatched by `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided, read the context document at the start of Phase 2 (RESEARCH) before reading target files. The context document contains:
- Library documentation and API references relevant to the task
- Codebase patterns and conventions discovered during analysis
- Best practices for the specific libraries and frameworks in use

Use this context to:
- Follow established patterns and conventions
- Use correct API signatures for libraries
- Avoid anti-patterns documented in the context
- Make implementation decisions consistent with the project style

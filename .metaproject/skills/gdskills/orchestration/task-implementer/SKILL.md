---
name: task-implementer
description: "Use when implementing a single decomposed task from issue-analyzer end-to-end, or executing autonomous code changes from a JSON task object."
triggers:
  - "Implement task"
  - "Execute task scenario"
  - "Code this task"
  - "Run task-implementer"
  - "Implement issue task"
metadata:
  author: "MrCipherSmith"
  version: "1.2.0"
  category: "implementation"
  agent_worthy: true
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# Task Implementer

## Purpose

Receives a single atomic task (JSON task object from `issue-analyzer`) and implements it end-to-end. Designed to run autonomously as a sub-agent — no user interaction required. Commits its changes to a shared feature branch managed by the orchestrator.

**Input:** JSON task object + workspace context (branch, codebase path, issue number)
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
  dependencies:         array of task_id strings (already satisfied — orchestrator ensures order)
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
  issue_number:         GitHub issue number (for commit messages)
  issue_title:          issue title (for commit messages)
```

**1.3 For fix tasks (dispatched from review loop):**

```
FIX_CONTEXT:
  review_feedback:      structured findings from reviewer (file, line, severity, message)
  original_task_id:     the task that introduced the issue
  iteration:            fix iteration number (1 or 2)
```

**1.4 Validate:**
```
ASSERT task_id IS NOT EMPTY           → otherwise ABORT("Missing task_id")
ASSERT task_type IN valid_types       → otherwise ABORT("Invalid task_type")
ASSERT target_files IS NOT EMPTY      → otherwise ABORT("No target files")
ASSERT codebase_path EXISTS           → otherwise ABORT("Codebase path not found")
ASSERT branch IS NOT EMPTY            → otherwise ABORT("Wrong branch checked out")
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

**2.1 Read all target files:**
- Read each file from `target_files` in full
- If a file does not exist yet, note it as "new file to create"
- Read the `context` field for additional type/signature info

**2.2 Read existing tests and stories:**
- If `existing_tests` is not "none" — read each test file
- If `existing_stories` is not "none" — read each story file
- Understand existing test patterns (describe/it structure, mocks, fixtures)

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

Rules are located at:
- OpenCode: `.metaproject/rules/core/<rule>.mdc`
- Cursor: `.cursor/rules/core/<rule>.mdc`
- Codex: `.metaproject/rules/core/<rule>.mdc`

**Output of Phase 2:** Mental model of the implementation:
```
RESEARCH_SUMMARY:
  target_files_status: [{path, exists: bool, line_count, key_exports}]
  test_pattern: <describe structure, assertion style>
  story_pattern: <Meta/StoryObj, args pattern>
  module_conventions: <naming, imports, exports, TS patterns>
  relevant_rules_loaded: [<rule names>]
```

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

**4.1 Implementation order (TDD Mode — test_case_specs provided):**
1. Read all test stubs from `test_case_specs.test_files`
2. Understand the expected API shape from test assertions
3. Implement types/interfaces to satisfy test imports
4. Implement code layer by layer until all tests are GREEN
5. Stories (if needed)

**4.2 Code standards (always follow):**
- TypeScript strict mode — no `any`, no `as` casts unless justified
- Use project path aliases for imports (`@components/...`, `@utils/...`)
- React components: `observer()` wrapping for MobX, named function components
- MobX stores: `makeObservable(this)` in constructor with explicit decorators, member order `private fields → public fields → constructor → public methods → private methods`, thin public `@action.bound` UI methods, non-mutating public helpers without actions, private API/IO methods, and `runInAction()` in private mutation blocks after every `await`
- Naming: PascalCase for components/types, camelCase for functions/variables, kebab-case for files
- Follow existing module patterns discovered in Phase 2

**4.3 Test standards:**
- Unit tests: Vitest with `describe`/`it`, `@testing-library/react` for components
- Use `data-testid` for test selectors
- Follow AAA pattern (Arrange, Act, Assert)
- Mock external dependencies, not internal module logic

**4.4 Story standards:**
- `Meta` + `StoryObj` pattern
- `args`-based variants
- `fn()` for action callbacks
- Cover: default state, edge cases, error states

**4.5 Commit after implementation:**

Create a conventional commit with the changes:
```bash
git add <modified files>
git commit -m "<type>(<scope>): <description>

refs #<issue_number>
task: <task_id>"
```

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
npm run lint              # ESLint (errors only)
npm run type-check        # tsc --noEmit
```

**5.2 Run if tests exist:**
```bash
npm test                  # Vitest run
```

If tests were created or modified, ensure they pass.

**5.3 Run if stories were created (optional, only if build is available):**
```bash
npm run build-storybook   # Verify stories compile
```

**5.4 Handle failures:**

| Failure | Action |
|---------|--------|
| Lint errors | Fix automatically using `npm run lint:fix:changed`, re-run lint |
| Type errors | Fix the type errors in code, re-commit |
| Test failures | Fix failing tests, re-commit |
| Story build failure | Fix story code, re-commit |

Maximum 3 self-fix attempts per verification step. 
**ROLLBACK POLICY**: If implementation fatally fails (e.g. tests still failing after 3 attempts or unresolvable compilation errors), you MUST run `git reset --hard` to clean the worktree before reporting the failure in Phase 6, unless explicitly instructed to leave it dirty.

**5.5 Re-commit fixes if any:**
```bash
git add <fixed files>
git commit -m "fix(<scope>): resolve lint/type/test issues

refs #<issue_number>
task: <task_id>"
```

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
  "notes": "<any warnings, blockers, or additional context>"
}
```

If `JOB_NAME` is not provided, skip the file write.

**6.2 Emit compact STATUS response:**

Return a compact STATUS response following `rules/core/subagent-status-protocol.md`.
**Do NOT include the full JSON block inline** — the orchestrator reads the result file when it needs details.
The inline response must contain only: STATUS line + Completed bullets + Files changed + Verification summary.

**Status classification:**
- `success` → `STATUS: DONE`
- `partial` → `STATUS: DONE_WITH_CONCERNS`
- `failed` → `STATUS: BLOCKED`

---

## Automation Settings

This skill is designed to run fully autonomously. The following settings control behavior:

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `auto_commit` | `true` | true/false | Automatically commit changes |
| `verify_lint` | `true` | true/false | Run ESLint after implementation |
| `verify_types` | `true` | true/false | Run type-check after implementation |
| `verify_tests` | `true` | true/false | Run tests after implementation |
| `verify_stories` | `false` | true/false | Build storybook to verify stories |
| `max_self_fix_attempts` | `3` | 1-5 | Max attempts to fix verification failures |
| `commit_message_style` | `conventional` | `conventional` | Commit format |

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
8. **DO** commit with conventional commit format referencing the issue number.
9. **DO** verify your work before reporting.
10. Return the JSON result object as your **final message** to the orchestrator.

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

See `rules/core/subagent-status-protocol.md` for full format specification and all four status types.

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

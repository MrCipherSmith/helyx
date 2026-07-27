---
name: task-implementer
description: "Autonomous implementation agent that receives a single atomic task (JSON task object from issue-analyzer) and implements it end-to-end: researches codebase, plans changes, writes code, creates tests/stories as needed, verifies via lint/type-check/test, and reports results. Use when: implementing a single decomposed task from issue-analyzer, executing code changes autonomously."
triggers:
  - "Implement task"
  - "Execute task scenario"
  - "Code this task"
  - "Run task-implementer"
  - "Implement issue task"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "implementation"
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
Phase 6: REPORT     →  Emit JSON result object
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

### Phase 2: RESEARCH

Deep-read the target files and surrounding module to understand patterns.

**2.0 Read job context (if available):**

If the orchestrator provided `JOB_NAME` and `CONTEXT_PATH`:
- Read `CONTEXT_PATH` (e.g., `.metaproject/jobs/<job-name>/ai/context.md`)
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

Based on what you're implementing, load and follow the relevant project rules:

| Task Type | Relevant Rules |
|-----------|---------------|
| `ui_component` | `code-style-patterns.mdc`, `frontend-assistant.mdc`, `storybook-guidelines.mdc` |
| `store_logic` | `code-style-patterns.mdc`, `mobx-store-template.mdc` |
| `service_api` | `code-style-patterns.mdc`, `nestjs-dto.mdc` |
| `fix` | Load rules based on the files being fixed |
| `mixed` | Load all applicable rules |

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

**4.1 Implementation order:**
1. Types and interfaces first (shared types, DTOs)
2. Service/API layer changes
3. Store/logic layer changes
4. Component/UI layer changes
5. Tests
6. Stories (if needed)

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

Emit a JSON result object as the final message to the orchestrator.

**Output structure:**

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

**Status classification:**
- `success`: All acceptance criteria met, all verifications pass
- `partial`: Some criteria met or some verification failures after self-fix attempts
- `failed`: Critical blockers prevented implementation. Worktree must be reverted via `git reset --hard`.

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

## Job Context Awareness

When dispatched by `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
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

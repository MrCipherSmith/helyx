---
name: context-collector
description: "Use when a job needs a unified context document — gathering docs, libraries, and references for sub-agents before execution."
triggers:
  - "Collect context"
  - "Build context"
  - "Gather context"
  - "Update context"
  - "Refresh context"
  - "Context for job"
  - "Research context"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "context"
  agent_worthy: true
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely.
This skill is for orchestrators and interactive session-level routing only.
Proceed directly with your assigned task.
</SUBAGENT-STOP>

# Context Collector

## Purpose

Collects and maintains a **unified context document** for a job. The context document is a curated, focused summary that all sub-agents can reference — it eliminates redundant research and ensures consistent understanding of the task across the entire job pipeline.

**Key responsibilities:**
1. Gather relevant local documentation (`docs/`, `jobs/`, `rules/core/`)
2. Identify libraries, patterns, and references used in the task area
3. Fetch external documentation (library docs, API references, best practices) via web
4. Extract and summarize only what is relevant to the specific task
5. Assemble everything into a single `context.md` document
6. Keep the context document up-to-date as the job evolves (version-tracked updates)

**Input:** Task description + job name + project path (from orchestrator or user)
**Output:** `context.md` document in `.metaproject/jobs/<job-name>/ai/` and `.metaproject/jobs/<job-name>/man/`, documented via `job-documenter`

## When to Use

- Called by `job-orchestrator` as an early plan step (after analysis, before implementation)
- Called directly by user when they need a research/context document for a task
- Called again during a job when additional context is needed (e.g., new library discovered during implementation)
- When any sub-agent reports missing context or encounters unfamiliar patterns

## Architecture: 5 Phases

```
Phase 1: RECEIVE     ->  Parse input, determine scope and focus areas
Phase 2: LOCAL       ->  Scan local docs, jobs, rules, codebase for relevant context
Phase 3: EXTERNAL    ->  Fetch external docs for libraries, APIs, best practices
Phase 4: SYNTHESIZE  ->  Merge all findings into a single context document
Phase 5: DOCUMENT    ->  Save via job-documenter, return result
```

---

## Input Contract

### When called by orchestrator:

```
ACTION:      collect | update
JOB_NAME:    <kebab-case job folder name>
JOBS_ROOT:   <JOBS_ROOT>
PROJECT_DIR: <absolute path to project directory>

DATA:
  TASK_DESCRIPTION:  <what the job is about — from issue, user request, or analysis>
  FOCUS_AREAS:       <optional — specific areas to focus on, e.g. "MobX stores", "pipeline validation">
  ANALYSIS_RESULT:   <optional — output from issue-analyzer, if available>
  KNOWN_LIBRARIES:   <optional — libraries already identified>
  UPDATE_REASON:     <required for ACTION=update — why context needs refreshing>
```

### When called directly by user:

The agent should ask for:
1. **What is the task?** — description of what needs to be done
2. **Project directory** — which project to analyze
3. **Job name** — if context should be saved to a job folder (optional for standalone use)
4. **Focus areas** — any specific libraries, patterns, or areas to prioritize

---

## Phase 1: RECEIVE

### 1.1 Parse Input

Extract the scope from the input:

```
SCOPE:
  task_description:   <what we're building/fixing/analyzing>
  focus_areas:        [<specific areas to research>]
  project_dir:        <project path>
  job_name:           <job folder name, if any>
  action:             collect | update
  analysis_available: <bool — was analysis result provided?>
```

### 1.2 Determine Research Targets

From the task description and focus areas, build a research plan:

```
RESEARCH_PLAN:
  local_targets:
    - docs:    [<relevant doc topics to look for>]
    - rules:   [<relevant rules to check>]
    - jobs:    [<previous related jobs to reference>]
    - code:    [<codebase areas to examine for patterns>]
  external_targets:
    - libraries:      [<npm packages / libraries to document>]
    - apis:           [<API references to fetch>]
    - best_practices: [<patterns / approaches to research>]
```

### 1.3 For ACTION=update

If this is an update:
1. Read the existing `context.md` from `.metaproject/jobs/<JOB_NAME>/ai/context.md`
2. Identify what sections need refreshing based on UPDATE_REASON
3. Preserve unchanged sections, only update/add relevant ones
4. Increment version in metadata

---

## Phase 2: LOCAL

Scan local sources for relevant context. Be selective — only include what is directly relevant to the task.

### 2.1 Documentation (`<DOCS_ROOT>/`)

```
1. List available docs:
   - Glob: docs/**/*.md
   
2. For each doc, check title and first 20 lines for relevance to task_description
   
3. For relevant docs:
   - Read full content
   - Extract: key decisions, constraints, architecture patterns, requirements
   - Summarize: 3-5 bullet points per doc, only task-relevant info
```

### 2.2 Previous Jobs (`<JOBS_ROOT>/`)

```
1. List existing job folders:
   - Read each jobs/*/README.md — check if related to current task
   
2. For related jobs:
   - Read their context.md (if exists) — reuse applicable context
   - Read their analysis.md — extract relevant patterns or decisions
   - Note: "Previous job <name> addressed <related topic>"
```

### 2.3 Rules (`<PROJECT_DIR>/rules/core/` or repo rules path)

```
1. Based on focus_areas and task_description, identify applicable rules:
   
   | Focus Area | Relevant Rules |
   |------------|---------------|
   | React components | code-style-patterns.mdc, frontend-assistant.mdc, storybook-guidelines.mdc |
   | MobX stores | code-style-patterns.mdc, mobx-store-template.mdc |
   | API / DTOs | nestjs-dto.mdc, code-style-patterns.mdc, api-contracts.mdc |
   | Testing | playwright-testing.mdc, storybook-guidelines.mdc, tdd-workflow.mdc |
   | General code | code-style-patterns.mdc, frontend-assistant.mdc |
   | TDD / test-first | tdd-workflow.mdc |
   | Architecture / layers | clean-architecture.mdc, solid-principles.mdc |
   | Error handling | error-handling.mdc |
   | Database / ORM | database-patterns.mdc |
   | Security | security-baseline.mdc |
   | Async code | async-patterns.mdc |
   
2. Read each applicable rule
3. Extract: specific conventions, required patterns, prohibited practices
4. Summarize: only the rules that directly apply to this task
```

### 2.4 Codebase Patterns (`PROJECT_DIR`)

```
1. Based on analysis_result (if available) or focus_areas:
   - Identify 2-3 files that are similar to what we're building/changing
   - Read them to extract patterns:
     * Import conventions (aliases, ordering)
     * Component structure (observer wrapping, props naming)
     * Store patterns (makeObservable(this), explicit decorators, thin @action.bound public actions, private API/IO methods, runInAction)
     * Test patterns (describe/it, mocks, fixtures)
     * File naming and organization
   
2. Summarize as "Codebase Conventions":
   - How similar code is structured in this project
   - Key patterns to follow for consistency
```

### 2.5 Test Framework Detection (`PROJECT_DIR`)

Always detect the test framework — `tests-creator` and `task-implementer` both need this.

```
1. Read package.json:
   - Check "dependencies" and "devDependencies" for:
     vitest, jest, @jest/*, mocha, jasmine, bun:test, pytest, go test
   
2. Check for config files:
   - vitest.config.ts / vitest.config.js
   - jest.config.ts / jest.config.js
   - .mocharc.* / mocha.opts

3. Read 2-3 existing test files (*.test.ts, *.spec.ts, test_*.py):
   - Import style (global vs explicit import)
   - Describe/it/test nesting depth
   - Assertion style (expect().toBe vs assert.equal)
   - Mock library (vi.fn / jest.fn / sinon)
   - Fixture patterns (factories, builders, inline data)
   - Test file location convention (co-located vs __tests__/)

4. Summarize as "Test Framework Context":
   framework: <vitest|jest|bun:test|mocha|pytest>
   import_style: esm | cjs | global
   file_pattern: "*.test.ts" | "*.spec.ts"
   file_location: co-located | __tests__ | tests/
   mock_library: vi | jest | sinon
   run_command: "bun test" | "npx vitest run" | "npm test"
   example_test_file: <path to a representative test>
```

### 2.6 Greptile Codebase Context (when available)

Greptile indexes the full repository and stores codebase-level context. If Greptile MCP is available in the session, query it as an additional local source — it can surface cross-file patterns that a manual scan would miss.

```
1. Try fetching stored custom context:
   mcp__greptile__get_custom_context({})
   or
   mcp__greptile__search_custom_context({ query: "<task_description>" })

2. If Greptile context is returned:
   - Extract: documented patterns, known exceptions, team conventions
   - Note: "Source: Greptile codebase index"

3. Check for relevant past review comments (signals about recurring issues):
   mcp__greptile__search_greptile_comments({ query: "<focus_area>", limit: 5 })
   - Extract recurring findings → add to "Known Issues / Watch Areas" section

4. If Greptile MCP is not available or returns empty: skip silently, proceed normally.
```

Greptile context is additive — it supplements local context, never replaces it.

**Output of Phase 2:**
```
LOCAL_CONTEXT:
  docs_summary:      [{source, key_points: [string]}]
  related_jobs:      [{job_name, relevance, key_findings}]
  applicable_rules:  [{rule, key_conventions: [string]}]
  codebase_patterns: [{area, patterns: [string], example_files: [path]}]
  test_framework:    {framework, import_style, file_pattern, file_location, mock_library, run_command, example_test_file}
  greptile_context:  {available: bool, patterns: [string], known_issues: [string]}
```

---

## Phase 3: EXTERNAL

Fetch external documentation for identified libraries, APIs, and best practices.

### 3.1 Identify External Targets

From the task description, analysis result, and codebase examination:

```
1. Scan package.json in PROJECT_DIR for dependencies
2. Cross-reference with focus_areas and affected files
3. Build external research list:
   
   EXTERNAL_TARGETS:
     libraries:
       - name: <package name>
         reason: <why this library is relevant>
         docs_url: <official docs URL, if known>
     best_practices:
       - topic: <e.g., "MobX computed vs autorun", "React memoization patterns">
         reason: <why this is relevant to the task>
```

### 3.2 Fetch Library Documentation

For each identified library:

```
1. Try fetching official documentation:
   - Use WebFetch to get the library's docs page
   - Focus on: API reference for the specific features we need
   - Skip: installation guides, getting started (unless relevant)

2. Extract only task-relevant sections:
   - API methods/hooks we'll use
   - Configuration options that apply
   - Known gotchas or migration notes
   - TypeScript types and interfaces

3. Summarize: 5-10 bullet points per library
   - Function signatures we'll use
   - Required patterns (e.g., cleanup, error handling)
   - Version-specific behavior if applicable
```

### 3.3 Fetch Best Practices

For each identified best practice topic:

```
1. Search for authoritative sources:
   - Official docs of the framework/library
   - Well-known pattern documentation (e.g., MobX official guides)
   
2. Extract actionable practices:
   - DO / DON'T patterns
   - Performance considerations
   - Common pitfalls to avoid
   
3. Summarize: 3-5 bullet points per topic, with code examples where helpful
```

### 3.4 Rate and Filter

Not all fetched content is equally useful. Rate each finding:

```
For each external finding:
  relevance: HIGH | MEDIUM | LOW
  - HIGH:   Directly answers a question about our implementation
  - MEDIUM: Provides useful background or alternative approaches
  - LOW:    Tangentially related, might be useful later

Include only HIGH and MEDIUM findings in the context document.
```

**Output of Phase 3:**
```
EXTERNAL_CONTEXT:
  libraries:       [{name, version, key_apis: [string], gotchas: [string], docs_url}]
  best_practices:  [{topic, dos: [string], donts: [string], examples: [string]}]
  references:      [{url, title, relevance, summary}]
```

---

## Phase 4: SYNTHESIZE

Merge all findings into a single, focused context document.

### 4.1 Context Document Structure

```markdown
# Context: <Job Title / Task Description>

## Task Overview
<2-3 sentences: what we're doing and why>

## Key Decisions & Constraints
<!-- From docs, rules, and previous jobs -->
- <decision or constraint 1>
- <decision or constraint 2>
- ...

## Applicable Rules & Conventions
<!-- From rules/core/ — only task-relevant extracts -->

### Code Style
- <convention 1>
- <convention 2>

### Architecture Patterns
- <pattern 1>
- <pattern 2>

### Testing Requirements
- <requirement 1>
- <requirement 2>

## Codebase Patterns
<!-- How similar code is written in this project -->

### File Structure
- <pattern>

### Component Patterns
- <pattern with brief code example>

### Store Patterns
- <pattern with brief code example>

## Libraries & APIs
<!-- External library documentation relevant to this task -->

### <Library Name> (v<version>)
- **Relevant APIs:** <list>
- **Key patterns:**
  - <pattern>
- **Gotchas:**
  - <gotcha>

### <Another Library>
- ...

## Best Practices
<!-- Researched best practices for the specific patterns we're using -->

### <Topic>
- DO: <practice>
- DON'T: <anti-pattern>
- Example:
  ```typescript
  // brief code example if helpful
  ```

## References
<!-- Links to source documentation -->
| Source | URL | Relevance |
|--------|-----|-----------|
| <title> | <url> | <HIGH/MEDIUM> |

## Previous Related Work
<!-- From previous jobs, if any -->
- <Job name>: <what was learned, what to reuse>

---

<!-- Document Metadata -->
| Key | Value |
|-----|-------|
| Created | <ISO 8601 UTC timestamp> |
| Updated | <ISO 8601 UTC timestamp> |
| Agent | context-collector |
| Task | <task description> |
| Job | <JOB_NAME> |
| Version | 1.0 |
| Status | final |
```

### 4.2 Quality Criteria

Before finalizing, validate the context document:

- [ ] Every section is directly relevant to the task — no padding
- [ ] Code examples are minimal but illustrative
- [ ] Library documentation covers the specific APIs we need, not generic overviews
- [ ] Rules and conventions are actionable (DO/DON'T format)
- [ ] References are linked and accessible
- [ ] Total document length is reasonable (aim for 200-500 lines, not 1000+)
- [ ] No duplicate information across sections

### 4.3 For ACTION=update

When updating an existing context:

1. Read existing `context.md`
2. Identify sections affected by UPDATE_REASON
3. Research only the new/changed areas (Phases 2-3, scoped)
4. Merge new findings into existing document:
   - Update affected sections in place
   - Add new sections if needed
   - Do NOT remove existing sections unless explicitly outdated
5. Increment Version in metadata (e.g., `1.0` -> `1.1`)
6. Update the `Updated` timestamp
7. Add update note to metadata or end of document:
   ```
   ## Update Log
   - v1.1 (<timestamp>): Added <library> documentation per <reason>. Agent: context-collector.
   - v1.0 (<timestamp>): Initial context. Agent: context-collector.
   ```

---

## Phase 5: DOCUMENT

Save the context document and notify orchestrator.

### 5.1 Save via job-documenter (when running within a job)

If JOB_NAME is provided, dispatch `job-documenter`:

```
ACTION: add-document
JOB_NAME: <JOB_NAME>
JOBS_ROOT: <JOBS_ROOT>

DATA:
  DOC_TYPE:    context
  TARGET:      both
  TITLE:       Context — <task description short>
  CONTENT:     <full context document>
  AGENT:       context-collector
  TASK:        Collect context for <task description>
  VERSION:     <1.0 for new, incremented for update>
  DOC_STATUS:  final
```

For ACTION=update, use the same flow — `job-documenter` will overwrite the existing `context.md`.

### 5.2 Save directly (when running standalone without a job)

If no JOB_NAME is provided:
- Write context to `<DOCS_ROOT>/context/<descriptive-slug>.md`
- Include full metadata block

## Reporting Results

Every final response to the orchestrator MUST begin with the status line:

```
STATUS: DONE

## Context collected
[summary of what was gathered]

## CONTEXT_RESULT
[the full result block]
```

Use `STATUS: DONE_WITH_CONCERNS` if context is partial. Use `STATUS: BLOCKED` if access fails.

**IRON LAW: THE FIRST LINE OF YOUR FINAL RESPONSE IS ALWAYS "STATUS: <STATUS>". THE CONTEXT_RESULT BLOCK FOLLOWS AFTER.**

### 5.3 Return Result

```
CONTEXT_RESULT:
  action:          collect | update
  status:          success | error
  job_name:        <JOB_NAME or null>
  context_path:    <path to context.md>
  version:         <document version>
  sections:
    local_sources:     <count of local sources used>
    external_sources:  <count of external sources fetched>
    rules_applied:     <count of rules extracted>
    libraries_documented: <count of libraries documented>
  summary:         <2-3 sentence summary of what context was collected>
  error_details:   <if status is error>
```

---

## Error Handling

| Error | Action |
|-------|--------|
| Job folder doesn't exist | If orchestrator call — ABORT, orchestrator must init job first. If user call — offer to create. |
| External URL fetch fails | Skip that source, note as "unavailable" in References, continue with remaining sources |
| No relevant local docs found | Proceed with external only, note "No local documentation found for this topic" |
| No relevant external docs found | Proceed with local only, note "External documentation not found — manual research may be needed" |
| Context document too large (>500 lines) | Aggressively summarize, move detailed info to separate `ai/context-details.md` |
| package.json not found | Skip library identification from deps, rely on focus_areas and analysis |

---

## Update Protocol

The context-collector is designed to be called **multiple times** during a job:

### When to trigger an update

| Trigger | Who Calls | What Happens |
|---------|-----------|--------------|
| New library discovered during implementation | Orchestrator or task-implementer (via orchestrator) | ACTION=update with FOCUS_AREAS=<new library> |
| Review finding suggests different pattern | Orchestrator after review step | ACTION=update with UPDATE_REASON=<review finding> |
| Sub-agent reports insufficient context | Orchestrator | ACTION=update with UPDATE_REASON=<what's missing> |
| User requests context refresh | User directly | ACTION=update with UPDATE_REASON=<user request> |

### Update flow

```
1. Read existing context.md
2. Parse UPDATE_REASON to determine scope
3. Run Phases 2-3 (LOCAL + EXTERNAL) with narrowed scope
4. Merge new findings into existing document (Phase 4.3)
5. Save updated document (Phase 5) with incremented version
6. Return CONTEXT_RESULT with updated section counts
```

---

## Prompt Template for Orchestrator

When the orchestrator dispatches this skill as a sub-agent:

```
You are the context-collector agent. Your task is to research and build
a context document for the current job.

Load the skill from: skills/context-collector/SKILL.md

ACTION: collect
JOB_NAME: <job-name>
JOBS_ROOT: <JOBS_ROOT>
PROJECT_DIR: <project path>

DATA:
  TASK_DESCRIPTION: <description from issue or user>
  FOCUS_AREAS: <areas to research>
  ANALYSIS_RESULT: <output from issue-analyzer, if available>
  KNOWN_LIBRARIES: <libraries already identified>

Execute all phases and return a CONTEXT_RESULT block.
```

For updates:

```
You are the context-collector agent. Your task is to update the existing
context document for this job.

Load the skill from: skills/context-collector/SKILL.md

ACTION: update
JOB_NAME: <job-name>
JOBS_ROOT: <JOBS_ROOT>
PROJECT_DIR: <project path>

DATA:
  TASK_DESCRIPTION: <original task description>
  UPDATE_REASON: <why context needs updating>
  FOCUS_AREAS: <new areas to research>

Execute update flow and return a CONTEXT_RESULT block.
```

---

## Rules of Engagement

1. **DO** focus on relevance — every line in the context document should help with the specific task.
2. **DO** include actionable information — patterns, conventions, API signatures, gotchas.
3. **DO** version-track every update with timestamp, version increment, and agent attribution.
4. **DO** preserve existing sections during updates unless they are explicitly outdated.
5. **DO** include code examples where they clarify a pattern (keep them minimal).
6. **DO** cross-reference with previous jobs to avoid rediscovering the same patterns.
7. **DO** return structured CONTEXT_RESULT for every action.
8. **DO NOT** include generic or obvious information (e.g., "React is a UI library").
9. **DO NOT** exceed ~500 lines in context.md — be aggressive with summarization.
10. **DO NOT** fetch external docs for standard well-known patterns already covered by project rules.
11. **DO NOT** modify any project files — this is a read + research + write-to-jobs skill only.
12. **DO NOT** skip the metadata block and update log — they are mandatory for version tracking.

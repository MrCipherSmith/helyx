---
name: feature-analyzer
description: "Use when analyzing feature branch changes across repos, planning implementation, or understanding backend→frontend contracts. NEVER start without explicit user confirmation of source, target, and branch."
triggers:
  - "Analyze branch"
  - "Analyze changes"
  - "Analyze commit"
  - "Study changes"
  - "Cross-repo analysis"
  - "Backend to frontend analysis"
  - "Feature analyzer"
metadata:
  author: "MrCipherSmith"
  version: "2.4.0"
  category: "analysis"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely.
This skill is for orchestrators and interactive session-level routing only.
Proceed directly with your assigned task.
</SUBAGENT-STOP>

# Feature Analyzer

## ⚠️ MANDATORY: DO NOT PROCEED WITHOUT CONTEXT

**CRITICAL RULE: You CANNOT start analysis until user explicitly provides:**
1. ✅ Source repository (local path)
2. ✅ Target repository (local path)
3. ✅ Branch to analyze
4. ✅ Confirmation of analysis scope

**DO NOT assume defaults. DO NOT use current directory. DO NOT proceed without asking.**

**If user says:** "Analyze everything related to variables in pipelines"

**You MUST respond:**
```
I'll help you analyze variables in pipelines. First, I need to clarify the context:

**SOURCE Repository** (where the changes exist):
- Local path: [user must provide, e.g., /Users/.../<PROJECT>]
- GitHub repo: [owner/repo]
- Branch to analyze: [branch-name]

**TARGET Repository** (where implementation will happen):
- Local path: [user must provide, e.g., /Users/.../<PROJECT>]
- GitHub repo: [owner/repo]
- Current branch: [branch-name]

**FOCUS** (from your request): "variables in pipelines"
- Keywords: variable, pipeline, param

Once you provide these details, I'll begin the focused analysis.
```

**If user doesn't provide all required info → STOP and ask again.**

---

## Purpose

Performs deep cross-repository analysis to understand business logic, architecture, API contracts, and implementation requirements. Generates structured documentation for both human developers and AI agents.

**Two Analysis Modes:**

**Mode A — Changes Analysis** (when base-branch provided):
- Analyze what changed FROM base-branch TO current branch
- Shows: additions, modifications, deletions
- Use for: reviewing PRs, understanding feature implementation

**Mode B — Current State Analysis** (when NO base-branch provided):
- Analyze ENTIRE codebase as it exists NOW
- Shows: existing functionality, architecture, patterns
- Use for: understanding system, formalizing features, exploring codebase

## Input

**Required context (ask before starting):**
- Source repository path + GitHub repo + branch to analyze
- Target repository path + current branch
- Analysis mode (A: changes from base-branch, or B: current state)
- Optional: GitHub Issue/PR URL, analysis focus keyword

**Prepared input:** Use `.metaproject/skills/gdskills/orchestration/feature-analyzer/analysis-request.template.md` to prepare structured input.
**Example:** See `.metaproject/skills/gdskills/orchestration/feature-analyzer/analysis-request.md` for a filled example.

---

## When to Use

**Mode A — Changes Analysis:**
- "Analyze feature branch changes from main"
- "Review what changed in this PR"
- "Compare feature-x with develop branch"

**Mode B — Current State Analysis:**
- "Analyze everything related to variables in pipelines"
- "How does authentication work in this codebase?"
- "Document the pipeline execution flow"
- "Formalize the user management feature"

---

## User-Specified Analysis Focus

When user specifies a focus area (e.g., "variables in pipelines"):

**Priority Boost Rules:**
- Files matching focus keywords → **Boost to P0** (even if normally P1/P2)
- Files referencing focus entities → **+1 priority level**
- Files in relevant directories → **+1 priority level**

**Keyword extraction:** parse main concept ("variables") + context ("pipelines") from user request.

> For detailed focus algorithm, bash search commands, and relationship mapping examples, see `SKILL.detail.md`.

---

## Workflow

Copy this checklist and track progress based on your Analysis Mode:

### Mode A: Changes Analysis (with base-branch)

```
Analysis Progress - Mode A (Changes):
🚫 PRE-STEP: VALIDATE CONTEXT
  □ Source repository path: _____________
  □ Target repository path: _____________
  □ Branch to analyze: _____________
  □ Base branch provided: _____________ (e.g., "main")
  □ Analysis Mode: A (Changes)
  □ User explicitly confirmed: _____________
□ Step 0.1: Check for existing analysis (cache lookup)
□ Step 0: Gather context (source, target, branch, base-branch, focus)
□ Step 1: GitHub MCP availability check
□ Step 2: Analyze GitHub issue/PR (if provided)
□ Step 3: Calculate BASE_SHA from merge-base (last branching point)
□ Step 4: Collect git changes (git diff BASE_SHA..HEAD)
□ Step 5: Categorize changed files: P0/P1/P2; apply focus boost
□ Step 6: Select 3-7 key files; Deep Dive — read selected files
□ Step 7: Analyze related tests
□ Step 8: Cross-repo dependency analysis
□ Step 9: Intermediate review (show user, wait for confirmation)
□ Step 10: Generate documentation
□ Step 11: Final validation and delivery
□ Step 12: Post-analysis (update doc registry)
```

### Mode B: Current State Analysis (without base-branch)

```
Analysis Progress - Mode B (Current State):
🚫 PRE-STEP: VALIDATE CONTEXT
  □ Source repository path: _____________
  □ Target repository path: _____________
  □ Branch to analyze: _____________
  □ Base branch: NOT PROVIDED (Mode B)
  □ Analysis Mode: B (Current State)
  □ User explicitly confirmed: _____________
□ Step 0.1: Check for existing analysis (cache lookup)
□ Step 0: Gather context (source, target, branch, focus)
□ Step 1: GitHub MCP availability check
□ Step 2: Analyze GitHub issue/PR (if provided)
□ Step 3: SKIP (no base-branch comparison)
□ Step 4: Search ENTIRE codebase for focus-related files
□ Step 5: Discover and categorize ALL relevant files: P0/P1/P2; apply focus boost
□ Step 6: Select 3-10 key files; Deep Dive — read to understand functionality
□ Step 6.5: FORMALIZE functionality (business logic, API contracts, state, data flow)
□ Step 7: Analyze tests (understand coverage)
□ Step 8: Cross-repo dependency analysis (find usages)
□ Step 9: Intermediate review with formalization
□ Step 10: Generate documentation (Feature Specification)
□ Step 11: Final validation and delivery
□ Step 12: Post-analysis
```

---

## Step 0: Context Gathering (MANDATORY)

**CRITICAL**: User MUST specify both Source and Target repositories.

**Ask all questions in one message:**

```
For cross-repository analysis, I need:

1. **SOURCE Repository** (where to analyze):
   - Local path: ?
   - GitHub repo (owner/repo): ?
   - Branch to analyze: ?

2. **TARGET Repository** (where implementation will happen, if applicable):
   - Local path: ?
   - GitHub repo (owner/repo): ?
   - Current branch: ?
   - (Can be same as source for single-repo analysis)

3. **Analysis Mode**:
   A. Changes Analysis — compare against base-branch (what changed)
      - Base branch: ? (e.g., "main", "develop")
   B. Current State Analysis — analyze codebase as-is (no base branch needed)

4. **Ticket/Reference** (GitHub Issue/PR URL, optional): ?

5. **Analysis Focus** (optional): specific area, e.g., "variables in pipelines", "auth changes"
```

**No default paths** — user must provide all locations explicitly.

**Before Step 1, verify context is complete:**

```
CONTEXT VALIDATION:
IF Source, Target, or Branch is missing → STOP, ask for missing info
IF Analysis mode not specified → ASK: Mode A (changes from base) or Mode B (current state)?
IF Mode A and no base branch → ASK: "What is the base branch?"
IF user says "just use current directory" → EXPLICITLY CONFIRM the path before proceeding
```

> For detailed decision tree and conversation example, see `SKILL.detail.md`.

---

## Step 1: GitHub MCP Availability Check

Before starting analysis:
- Try to fetch simple repo info via GitHub MCP
- If unavailable: notify user, offer Option A (restart MCP) or Option B (git-only, limited context)

---

## Step 2: GitHub Issue/PR Analysis (if provided)

- Fetch Issue/PR and all comments via GitHub MCP
- Understand business goal — what problem does the feature solve?
- Extract acceptance criteria and requirements

---

## Step 3: Git Changes Collection

**CRITICAL**: Find the last branching point (merge-base), NOT the current HEAD of the parent branch.
This ensures you analyze only feature branch changes, not unrelated changes from other merged PRs.

```bash
# Find branching point
BASE_SHA="$(git merge-base HEAD <parent_branch>)"

# Collect changes
git log --oneline "${BASE_SHA}..HEAD"
git diff --stat "${BASE_SHA}..HEAD"
git diff --name-status "${BASE_SHA}..HEAD"
git diff "${BASE_SHA}..HEAD"
```

> For the full BASE_SHA detection algorithm (with fallback logic for main/master/upstream), see `SKILL.detail.md`.

---

## Step 4: File Categorization and Prioritization

### Priority Levels

**P0 — MUST ANALYZE (Critical)**:
- API contracts: DTOs, interfaces, type definitions
- Public API endpoints (controllers, routes)
- Database schema changes, auth changes, config changes

**P1 — SHOULD ANALYZE (Important)**:
- Business logic (services, use cases)
- State management (stores, contexts)
- Error handling, validation logic

**P2 — NICE TO HAVE (Optional)**:
- Pure UI components, refactoring, tests, docs, package updates

### Standard File Selection

From P0: select up to 5 most important (sort by API contracts → business logic → infrastructure).
From P1: select up to 3 if P0 < 3. Skip P2 unless P0+P1 < 3.

When focus specified: boost files matching focus keywords to P0; select ALL focus-matching P0 files.

> For the full focus-based selection algorithm with examples, see `SKILL.detail.md`.

---

## Step 5: Deep Dive Protocol

**You CANNOT make conclusions from git diff alone. You MUST:**

1. **Read selected files**:
   - Small/medium files: read completely
   - Large files (> 500 lines): use outline/grep to locate relevant sections, then read only those ranges
2. **Understand context**: architecture role, dependencies, what depends on it
3. **Find and analyze tests**: look for matching test files, understand coverage
4. **Check rules compliance**: verify against `code-style-patterns.mdc`

---

## Step 6: Cross-Repository Analysis (Source → Target)

1. **Dependency search**: find all target files importing changed DTOs/APIs from source
2. **Contract divergence**: compare new source contracts with current target implementation
3. **Target deep dive**: read 2-3 key components that will need changes
4. **Target rules compliance**: check `.cursor/rules/core/*.mdc` in target repo

---

## Step 7: UI Analysis (if applicable)

Check `AGENTS.md` for available tools (`playwright-testing.mdc`, `storybook-guidelines.mdc`). Analyze visual regression requirements, component behavior changes, accessibility impact.

---

## Step 8: Integration with Other Skills

Before finalizing, consider running:
- `skills/code-style-review` — if architecture changes detected
- `skills/code-ai-review` — for self-validation of findings
- `skills/code-mobx-store-review` — if store changes found

---

## Step 9: Intermediate Review (CRITICAL)

After completing analysis, **show user** before generating full report:

```
═══════════════════════════════════════════════
   INTERMEDIATE ANALYSIS SUMMARY
═══════════════════════════════════════════════

Scope:
- Source: [repo] @ [branch]
- Target: [repo] @ [branch]
- Files analyzed: [N] (P0: [N], P1: [N])
- BASE_SHA: [sha]

Key Findings:
1. [Brief finding 1]
2. [Brief finding 2]

Cross-Repo Impact:
- [ ] Breaking API changes detected
- [ ] New endpoints to implement
- [ ] DTO changes affecting frontend

Estimated Complexity: [Low/Medium/High]

Continue to full documentation? [Y/n]
═══════════════════════════════════════════════
```

Wait for user confirmation before generating full report.

---

## Step 10: Documentation Generation

### Output Structure

```
<DOCS_ROOT>/analysis/<feature-name>-<YYYY-MM-DD>/
├── README.md                    # Index and navigation
├── report/
│   ├── en/report.md             # English for humans
│   ├── ru/report.md             # Russian for humans
│   └── ai/report.md             # Structured for AI agents (EN)
├── plans/
│   ├── en/implementation-plan.md
│   ├── ru/implementation-plan.md
│   └── ai/implementation-plan.md
├── contracts/
│   ├── api-changes.md           # API contract diff
│   └── dto-comparison.md        # Before/after DTOs
└── metrics/
    └── analysis-metrics.md      # Analysis metadata
```

The AI-readable format (`report/ai/`, `plans/ai/`) uses Gherkin-style scenarios.
> For full Gherkin output format and syntax rules, see `SKILL.detail.md`.

---

## Step 11: Content Requirements

- Every claim MUST reference specific code: `[filename.ts:L123](file:///absolute/path#L123)`
- Minimum 3 code examples per report
- Mermaid diagrams for architecture, tables for DTO changes, flowcharts for data flow
- Multi-language: `en/` for humans, `ru/` for humans, `ai/` for AI agents

---

## Step 12: Error Handling

| Situation | Fallback |
|-----------|----------|
| GitHub MCP unavailable | Use git history only; notify user |
| No tests found | Note risk, recommend coverage |
| Cannot determine BASE_SHA | Ask user for parent branch, or use `--first-parent` estimate |
| Empty diff | Check staged (`--cached`), untracked (`git status`), wrong branch |
| Cross-repo access denied | Ask for manual path, or do source-only analysis |

---

## Step 13: Analysis Metrics

Track and include in `metrics/analysis-metrics.md`:
- Duration, files analyzed (P0/P1/P2), lines changed
- Cross-repo dependencies, API endpoints changed, DTOs modified
- Breaking changes count, test coverage %, risk level
- Complexity score: `(P0×3) + (P1×2) + (P2×1) + (breaking_changes×5)` — 0-10 low, 11-25 medium, 26+ high

---

## Step 14: Validation Checklist

Before finalizing:
- [ ] All P0 files analyzed completely
- [ ] Target repository analyzed (if cross-repo)
- [ ] Minimum 3 code examples included
- [ ] All file references include line numbers
- [ ] API contracts documented
- [ ] Breaking changes clearly identified
- [ ] Implementation plan provided
- [ ] Metrics calculated
- [ ] User approved intermediate review

---

## Step 15: Post-Analysis

Follow `documentation-management.mdc`: update `<DOCS_ROOT>/readme.md`, add entry to analysis index, tag with keywords.

---

## Rules and Guidelines

1. **Always follow** `documentation-management.mdc` for doc structure
2. **Always check** `code-style-patterns.mdc` for compliance
3. **Always use** AGENTS.md to discover available skills and tools
4. **Never assume** — ask user when unclear
5. **Never skip** intermediate review for complex analyses (P0 files > 3)
6. **Always provide** concrete, actionable recommendations
7. **Always include** both human-readable and AI-readable formats

---

## Success Criteria

Analysis is successful when:
- Business logic is fully understood and documented
- API contracts are clearly specified
- Breaking changes are identified
- Implementation plan is actionable
- User confirms understanding via intermediate review
- All P0 files analyzed completely

---

> **Extended documentation**: detailed analysis mode descriptions, file selection algorithms, Gherkin output format, cache/existing-report handling, and full examples are in `SKILL.detail.md`.

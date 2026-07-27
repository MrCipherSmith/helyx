---
name: feature-analyzer
description: "Deep cross-repository analysis of feature branches: requires explicit context gathering from user (source/target repos, branch), git diff analysis, mandatory Deep Dive with code examples, API contract analysis, and structured documentation. Use when: analyzing branch changes across repos, planning feature implementation, understanding backend→frontend contracts. NEVER start analysis without explicit user confirmation of source, target, and branch."
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

**Mode A - Changes Analysis** (when base-branch provided):
- Analyze what changed FROM base-branch TO current branch
- Shows: additions, modifications, deletions
- Use for: reviewing PRs, understanding feature implementation

**Mode B - Current State Analysis** (when NO base-branch provided):
- Analyze ENTIRE codebase as it exists NOW
- Shows: existing functionality, architecture, patterns
- Use for: understanding system, formalizing features, exploring codebase

**Key Capabilities:**
- Cross-repository analysis (Source → Target)
- API contract validation (DTOs, interfaces)
- Business logic extraction and formalization
- Implementation planning
- Multi-language documentation (EN for AI agents, EN/RU for humans)
- Focus-based prioritization (e.g., "variables in pipelines")

## When to Use

### Mode A: Changes Analysis (provide base-branch)
- "Analyze feature branch changes from main"
- "Review what changed in this PR"
- "Compare feature-x with develop branch"
- Understanding backend API changes for frontend implementation
- Planning feature implementation based on changes

### Mode B: Current State Analysis (no base-branch)
- "Analyze everything related to variables in pipelines" (explore current system)
- "How does authentication work in this codebase?"
- "Document the pipeline execution flow"
- "Formalize the user management feature"
- Understanding existing system architecture
- Creating feature specification from existing code

### Examples by Mode

**Mode A Examples (with base-branch):**
- "Analyze branch feature/auth-v2 from main" → Changes Analysis
- "Review changes in PR #123 against develop" → Changes Analysis
- "What changed in DTOs since last release?" → Changes Analysis

**Mode B Examples (without base-branch):**
- "Analyze variables in pipelines" → Current State Analysis
- "How does error handling work?" → Current State Analysis
- "Document the caching mechanism" → Current State Analysis
- "Explain the user workflow" → Current State Analysis

## User-Specified Analysis Focus (Optional but Recommended)

User can request **targeted analysis** with specific focus:

**Examples:**
- "Analyze everything related to **variables in pipelines**"
- "Focus on **authentication changes** in this branch"
- "Find all changes related to **DTO validations**"
- "Analyze **performance optimizations** specifically"
- "Focus on **error handling** modifications"

### Focus Keywords Priority System

When user specifies focus, adjust priorities:

**Priority Boost Rules:**
- Files matching focus keywords → **Boost to P0** (even if normally P1/P2)
- Files referencing focus entities → **+1 priority level**
- Files in relevant directories → **+1 priority level**

**Example:** Focus = "variables in pipelines"
```
Files containing "variable" in path or content:
  - src/pipelines/variable-resolver.ts → P0 (boosted from P1)
  - src/models/pipeline-variable.dto.ts → P0 (already P0)
  - src/components/variable-input.tsx → P0 (boosted from P2)

Files in pipelines directory:
  - src/pipelines/pipeline-runner.ts → P1 (context, +1 priority)
```

### Search Strategy for Focus Areas

**Step 1: Keyword Extraction**
Extract key terms from user request:
- Main concept: "variables"
- Context: "pipelines"
- Action: "analyze"

**Step 2: Multi-Scope Search**
Search across entire codebase (not just changed files):

```bash
# Search in changed files first
git diff --name-only | xargs grep -l "variable" 2>/dev/null

# Search in broader codebase for context
grep -r "variable" --include="*.ts" --include="*.tsx" src/pipelines/ | head -20

# Search related terms
grep -ri "var\|param\|arg\|input" --include="*.ts" src/pipelines/ | head -20
```

**Step 3: Relationship Mapping**
Identify related components:
- What uses variables? → PipelineRunner, PipelineBuilder
- What defines variables? → VariableService, VariableDTO
- Where are variables stored? → VariableStore, PipelineContext

**Step 4: Cross-Reference Analysis**
Check target repository for:
- Files importing Variable-related types
- Components using pipeline variables
- Tests covering variable functionality

### Focus-Based File Prioritization Algorithm

```
Standard Priority + Focus Boost = Final Priority

For each changed file:
1. Assign base priority (P0/P1/P2)
2. IF file matches focus keywords → Boost to P0
3. IF file references focus entities → +1 level
4. IF file in focus directory → +1 level
5. IF file is dependency of focus files → Keep base priority
6. ELSE → Standard priority

Select top 7 files by final priority
```

### Focus Analysis Workflow Adjustment

Add to workflow:
```
Analysis Progress:
...
□ Step 4.5: Apply focus filter and boost priorities
□ Step 5.5: Search broader codebase for focus context
□ Step 6.5: Map relationships between focus entities
...
```

## Workflow

Copy this checklist and track progress based on your Analysis Mode:

### Mode A: Changes Analysis (with base-branch)

Use when analyzing what changed FROM base-branch TO current branch.

```
Analysis Progress - Mode A (Changes):
🚫 PRE-STEP: VALIDATE CONTEXT
  □ Source repository path: _____________
  □ Target repository path: _____________
  □ Branch to analyze: _____________
  □ Base branch provided: _____________ (e.g., "main")
  □ Analysis Mode: A (Changes)
  □ User explicitly confirmed: _____________
□ Step 1: Gather context (source, target, branch, base-branch, focus)
□ Step 1.5: Parse focus keywords (if focus specified)
□ Step 2: Verify GitHub MCP availability
□ Step 3: Analyze GitHub issue/PR (if provided)
□ Step 4: Calculate BASE_SHA from merge-base (last branching point)
□ Step 5: Collect git changes (git diff BASE_SHA..HEAD)
□ Step 6: Categorize changed files: P0/P1/P2
□ Step 6.5: Apply focus-based priority boost
□ Step 7: Select 3-7 key files from CHANGED files
□ Step 8: Deep Dive - read changed files
□ Step 9: Analyze related tests
□ Step 10: Check rules compliance
□ Step 11: Cross-repo dependency analysis
□ Step 12: UI analysis (if applicable)
□ Step 13: Intermediate review
□ Step 14: Generate documentation
□ Step 15: Final review and delivery
```

### Mode B: Current State Analysis (without base-branch)

Use when analyzing ENTIRE codebase to understand existing functionality.

```
Analysis Progress - Mode B (Current State):
🚫 PRE-STEP: VALIDATE CONTEXT
  □ Source repository path: _____________
  □ Target repository path: _____________
  □ Branch to analyze: _____________
  □ Base branch: NOT PROVIDED (Mode B)
  □ Analysis Mode: B (Current State)
  □ User explicitly confirmed: _____________
□ Step 1: Gather context (source, target, branch, focus)
□ Step 1.5: Parse focus keywords (if focus specified)
□ Step 2: Verify GitHub MCP availability
□ Step 3: Analyze GitHub issue/PR (if provided)
□ Step 4: SKIP (no base-branch comparison)
□ Step 5: Search ENTIRE codebase for focus-related files
□ Step 6: Discover and categorize ALL relevant files: P0/P1/P2
□ Step 6.5: Apply focus-based priority boost
□ Step 7: Select 3-10 key files from ENTIRE codebase
□ Step 8: Deep Dive - read files to understand functionality
□ Step 8.5: FORMALIZE functionality (document what exists)
  - Business logic
  - API contracts
  - State management
  - Data flow
  - Integration points
□ Step 9: Analyze tests (understand coverage)
□ Step 10: Check rules compliance
□ Step 11: Cross-repo dependency analysis (find usages)
□ Step 12: UI analysis (if applicable)
□ Step 13: Intermediate review with formalization
□ Step 14: Generate documentation (Feature Specification)
□ Step 15: Final review and delivery
```

---

## Mode B: Feature Formalization (Current State Analysis)

When user does NOT provide base-branch, you must **formalize existing functionality** instead of analyzing changes.

### What is Feature Formalization?

**Purpose**: Create comprehensive specification of existing functionality as it works RIGHT NOW.

**Difference from Changes Analysis**:
- **Changes Analysis**: "What changed from version A to version B?"
- **Feature Formalization**: "How does this functionality work in the current codebase?"

### Formalization Checklist

For each analyzed component, document:

```
COMPONENT FORMALIZATION TEMPLATE:

1. PURPOSE
   - What business problem does this solve?
   - Who are the users?
   - When is it used?

2. API CONTRACT (if applicable)
   - Input parameters
   - Return types
   - Error responses
   - Authentication/authorization requirements

3. BUSINESS LOGIC
   - Core algorithms
   - Validation rules
   - Business constraints
   - Decision trees

4. STATE MANAGEMENT
   - What state is maintained?
   - Where is it stored?
   - How is it updated?
   - Lifecycle of state

5. DATA FLOW
   - Input sources
   - Processing steps
   - Output destinations
   - Side effects

6. INTEGRATION POINTS
   - External services called
   - Events published/consumed
   - Database interactions
   - File system operations

7. ERROR HANDLING
   - Expected error scenarios
   - Recovery mechanisms
   - Fallback behavior

8. EDGE CASES
   - Boundary conditions
   - Empty/null handling
   - Concurrency issues
   - Performance constraints

9. TESTING
   - Test coverage
   - Critical test scenarios
   - Manual testing steps

10. USAGE EXAMPLES
    - Code examples
    - Common patterns
    - Anti-patterns to avoid
```

### Search Strategy for Mode B

When no base-branch provided, search ENTIRE codebase:

```bash
# 1. Find all files related to focus keywords
grep -r "focus_keyword" --include="*.ts" --include="*.tsx" src/ | head -50

# 2. Find files in relevant directories
find src/path -type f \( -name "*.ts" -o -name "*.tsx" \) | head -30

# 3. Find entity definitions
# (classes, interfaces, types matching focus)
grep -l "class Focus\|interface Focus\|type Focus" --include="*.ts" src/

# 4. Find consumers (what uses these entities)
grep -l "import.*Focus\|from.*focus" --include="*.ts" src/

# 5. Find tests related to focus
grep -r "focus_keyword" --include="*.spec.ts" --include="*.test.ts" src/
```

### Output for Mode B

Generate **Feature Specification Document** instead of Change Analysis:

```
<DOCS_ROOT>/analysis/<feature>-current-state-<date>/
├── README.md
├── specification/
│   ├── en/
│   │   └── feature-specification.md    # Human-readable spec
│   ├── ru/
│   │   └── feature-specification.md    # Human-readable spec (RU)
│   └── ai/
│       └── feature-specification.md    # Gherkin format
├── architecture/
│   ├── data-flow.md                    # Data flow diagrams
│   ├── component-diagram.md            # Component relationships
│   └── api-contracts.md                # API specifications
├── usage/
│   ├── examples.md                     # Code examples
│   └── patterns.md                     # Common patterns
└── tests/
    └── test-coverage.md                # Testing documentation
```

---

## Timeouts and Limits (CRITICAL)

**Analysis must be time-boxed to prevent excessive duration.**

### Default Timeouts

| Phase | Max Duration | Action on Timeout |
|-------|-------------|-------------------|
| GitHub MCP verification | 30 seconds | Ask user to restart or skip |
| Git history analysis | 2 minutes | Proceed with limited history |
| Single file reading | 30 seconds per file | Skip and mark as "partial" |
| Cross-repo dependency search | 3 minutes | Provide partial results |
| Documentation generation | 5 minutes | Generate minimal report |
| **Total analysis** | **30 minutes** | Force intermediate review |

### Timeout Handling Strategy

**When approaching timeout:**
1. Notify user: "Analysis approaching 30-minute limit"
2. Show current progress and what remains
3. Offer options:
   - **Continue**: Extend timeout by 15 minutes
   - **Split**: Break into multiple smaller analyses
   - **Partial**: Generate report with current findings
   - **Prioritize**: Focus only on P0 files

### File Count Limits

**Automatic scope reduction when limits exceeded:**

| Total Changed Files | Action |
|-------------------|---------|
| 1-10 files | Analyze all P0, selected P1 |
| 11-30 files | Analyze P0 only (up to 10) |
| 31-50 files | Top 7 P0 files only |
| 50+ files | **STOP** — ask user to narrow scope |

**When 50+ files detected:**
```
⚠️ LARGE CHANGESET DETECTED

Found [N] changed files. This is too large for effective analysis.

Options:
1. Analyze specific directory: [suggest paths]
2. Analyze specific file types: [API files only]
3. Split by commits: analyze first [N] commits
4. Manual selection: user specifies which files

Recommended: Option [suggested]
```

### Progress Monitoring

**Every 10 minutes, provide status update:**
```
⏱️ Time elapsed: [X] minutes
📊 Progress:
  - Phase: [current phase]
  - Files analyzed: [N]/[total]
  - P0: [N] complete
  - P1: [N] complete
⏰ Estimated remaining: [X] minutes
```

---

## Cache and Existing Reports Check (Step 0.1)

**Before starting analysis, check for existing reports to avoid duplication.**

### Cache Lookup

```bash
# Check if analysis already exists for this branch
git_branch="$(git rev-parse --abbrev-ref HEAD)"
git_sha="$(git rev-parse HEAD)"
analysis_dir="<DOCS_ROOT>/analysis/${git_branch}-*"

# Look for recent analysis (within last 7 days)
find <DOCS_ROOT>/analysis/ -name "*.md" -mtime -7 | grep "${git_branch}"
```

### Existing Report Detection

**If recent analysis found, ask user:**

```
🔍 EXISTING ANALYSIS DETECTED

Found existing analysis for branch [branch-name]:
- Date: [creation date]
- Path: [path/to/analysis]
- Coverage: [N files analyzed]
- Completeness: [full/partial]

Options:
1. ⏩ Use existing (skip new analysis)
2. 🔄 Refresh (update with latest changes)
3. 📊 Compare (show diff between existing and current)
4. 🆕 New analysis (ignore existing, start fresh)
5. 🗑️ Archive old & create new

Recommended: [suggested option based on age and changes]
```

### Cache Invalidation Rules

**Always create new analysis when:**
- [ ] Branch has new commits since last analysis
- [ ] BASE_SHA changed (rebased branch)
- [ ] User explicitly requests fresh analysis
- [ ] Existing analysis older than 7 days
- [ ] Existing analysis marked as "partial" or "incomplete"

**Can reuse existing when:**
- [x] Same commit SHA
- [x] Same BASE_SHA
- [x] Analysis complete and recent (< 7 days)
- [x] User confirms no significant changes

### Incremental Analysis

**If refreshing existing analysis:**

1. Load previous analysis metadata
2. Identify new commits since last analysis: `git log ${LAST_SHA}..HEAD`
3. Analyze only new/changed files
4. Merge findings with previous report
5. Update timestamps and version

```
🔄 INCREMENTAL UPDATE MODE

Previous analysis: [date]
New commits since then: [N]
Files changed in new commits: [N]

Analyzing only new changes...
```

### Cache Storage

**Metadata file for caching:** `<DOCS_ROOT>/analysis/.cache/index.json`

```json
{
  "analyses": [
    {
      "branch": "feature-name",
      "sha": "abc123",
      "base_sha": "def456",
      "path": "feature-name-2024-01-15",
      "created_at": "2024-01-15T10:00:00Z",
      "updated_at": "2024-01-15T10:00:00Z",
      "status": "complete",
      "files_analyzed": 12,
      "coverage": "full"
    }
  ]
}
```

---

## Step 0: Context Gathering (MANDATORY)

**CRITICAL**: User MUST specify both Source and Target repositories.

### Analysis Mode Selection (CRITICAL)

User can choose between **two analysis modes**:

**Mode A: Changes Analysis** (with base-branch)
- Analyze changes FROM base-branch TO current branch
- Shows what changed, what was added/removed/modified
- Use when: reviewing feature implementation, checking PR changes

**Mode B: Current State Analysis** (without base-branch)
- Analyze ENTIRE codebase as it exists NOW
- Shows current functionality, architecture, patterns
- Use when: understanding existing system, formalizing features, exploring codebase

If user doesn't specify base-branch, default to **Mode B**.

---

### Context Questions

Ask in one message:

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
   A. Changes Analysis - compare against base-branch (see what changed)
      - Base branch: ? (e.g., "main", "develop", "master")
   B. Current State Analysis - analyze entire codebase as-is
      - No base branch needed

4. **Ticket/Reference** (GitHub Issue/PR URL, optional): ?

5. **Analysis Focus** (optional):
   - [ ] API contracts only
   - [ ] Full implementation plan
   - [ ] Breaking changes assessment
   - [ ] Business logic understanding
   - [ ] Specific area (e.g., "variables in pipelines", "auth changes")
   - [ ] Feature formalization (document existing functionality)

6. **Specific Focus Area** (if "Specific area" selected above):
   - What to focus on: ? (e.g., "variables", "pipelines", "authentication", "DTOs")
   - Where to look: ? (e.g., "src/pipelines", "src/auth", "src/models")
   - Context keywords: ? (optional, comma-separated)
```

**No default paths** - user must provide all locations explicitly.

**If user provides natural language focus** (e.g., "analyze everything related to variables in pipelines"):
- Parse and extract: Focus = "variables", Location = "pipelines"
- Apply Focus-Based Prioritization (see above)

---

## ⛔ GUARD CLAUSE: Validate Context Before Proceeding

**Before Step 1, verify you have explicit user confirmation:**

```
CONTEXT VALIDATION CHECKLIST:
□ Source repository path: [PROVIDED / NOT PROVIDED]
□ Target repository path: [PROVIDED / NOT PROVIDED]
□ Branch to analyze: [PROVIDED / NOT PROVIDED]
□ Analysis mode: [A - Changes / B - Current State / NOT SPECIFIED]
□ Base branch (if Mode A): [PROVIDED / NOT PROVIDED]
□ Focus area (if any): [PARSED / NOT SPECIFIED]

IF Source, Target, or Branch is "NOT PROVIDED":
  → STOP analysis
  → Ask user for missing information
  → DO NOT proceed until all fields are provided

IF Analysis mode is "NOT SPECIFIED":
  → ASK: "Do you want to analyze (A) changes from base-branch or (B) current codebase state?"
  → Wait for user choice

IF Mode A and Base branch is "NOT PROVIDED":
  → ASK: "What is the base branch to compare against? (e.g., main, develop)"
  → OR: "If you want to analyze current state without comparing to base, choose Mode B"
  
IF user says "just use current directory" or similar:
  → EXPLICITLY CONFIRM: "I will analyze [current path] @ [current branch]. Confirm? [Y/n]"
  → Wait for explicit Y before proceeding
```

### Analysis Mode Decision Tree

```
User Request: "Analyze variables in pipelines"

├─→ User provides base-branch (e.g., "from main")
│   └─→ Mode A: Changes Analysis
│       └─→ Analyze diff between main..current-branch
│       └─→ Focus on what CHANGED regarding variables
│
└─→ User does NOT provide base-branch
    └─→ Mode B: Current State Analysis
        └─→ Analyze entire codebase as-is
        └─→ Focus on what EXISTS regarding variables
        └─→ Formalize functionality, document patterns
```

**Example conversation:**
```
User: "Analyze everything related to variables in pipelines"

Agent: "I'll help you analyze variables in pipelines. First, I need context:

SOURCE Repository (where changes exist):
- Local path: ?"

User: "/Users/.../<PROJECT>"

Agent: "✓ Source: /Users/.../<PROJECT>

TARGET Repository (where to implement):
- Local path: ?"

User: "/Users/.../<PROJECT>"

Agent: "✓ Target: /Users/.../<PROJECT>

Branch to analyze:
- Branch name: ?"

User: "feature/pipeline-variables"

Agent: "✓ Branch: feature/pipeline-variables

**CONFIRMATION:**
Analyze 'feature/pipeline-variables' with focus on 'variables in pipelines'?
- Source: /Users/.../<PROJECT>
- Target: /Users/.../<PROJECT>
- Focus: variables in pipelines

Start analysis? [Y/n]"

User: "Y"

Agent: "✓ Starting analysis..."
```

---

## Step 1: GitHub MCP Availability Check

Before starting analysis:

```bash
# Check if GitHub MCP is responsive
# Try to fetch a simple repo info
```

**If GitHub MCP unavailable:**
1. Notify user: "GitHub MCP is not available. Options:"
2. Option A: "Restart GitHub MCP and continue"
3. Option B: "Proceed with git-only analysis (limited context)"
4. Wait for user choice before proceeding

---

## Step 2: GitHub Issue/PR Analysis (if provided)

- Use GitHub MCP to fetch Issue/PR and all comments
- **CRITICAL**: Understand business goal - what problem does the feature solve?
- Extract acceptance criteria and requirements
- Note any architectural decisions or constraints mentioned

---

## Step 3: Git Changes Collection

### Base Branch Determination Rule (CRITICAL)

**The base branch MUST be determined from the last branching point (merge-base), NOT from the current HEAD of the parent branch.**

This ensures you analyze only the changes made in the feature branch, not changes that occurred in the parent branch after the feature was branched.

**Why this matters:**
- If you compare against `origin/main` HEAD, you'll see unrelated changes from other merged PRs
- You MUST find the exact commit where the feature branch diverged
- Use `git merge-base` to find this point

### Calculate BASE_SHA

**ALGORITHM - Find the last branching point:**

```bash
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || true)"

# Step 1: Determine parent branch candidate
PARENT=""
if git rev-parse --verify -q "origin/main" >/dev/null; then
  PARENT="origin/main"
elif git rev-parse --verify -q "origin/master" >/dev/null; then
  PARENT="origin/master"
elif git rev-parse --verify -q "main" >/dev/null; then
  PARENT="main"
elif git rev-parse --verify -q "master" >/dev/null; then
  PARENT="master"
elif [ -n "$UPSTREAM_REF" ] && [ "$UPSTREAM_REF" != "$BRANCH" ] && [ "$UPSTREAM_REF" != "origin/$BRANCH" ]; then
  PARENT="@{upstream}"
else
  echo "Cannot determine parent ref" >&2
  exit 1
fi

# Step 2: CRITICAL - Find the actual branching point (merge-base)
# This gives you the commit where feature branch diverged from parent
BASE_SHA="$(git merge-base HEAD "$PARENT")"
```

**Verification:**
```bash
# Verify BASE_SHA is correct
echo "Feature branch: $BRANCH"
echo "Parent branch: $PARENT"
echo "Branching point (BASE_SHA): $BASE_SHA"
echo "Commits in feature branch:"
git log --oneline "${BASE_SHA}..HEAD"
```

**Result:** `BASE_SHA` is the exact commit where your feature branch started - this is your analysis starting point.
fi

BASE_SHA="$(git merge-base HEAD "$PARENT")"
```

### Collect Changes
```bash
# Committed changes
git log --oneline "${BASE_SHA}..HEAD"
git diff --stat "${BASE_SHA}..HEAD"
git diff --name-status "${BASE_SHA}..HEAD"
git diff "${BASE_SHA}..HEAD"

# Full snapshot (commits + staged + unstaged)
git diff --stat "${BASE_SHA}"
git diff --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

---

## Step 4: File Categorization and Prioritization

### Priority Levels

**P0 - MUST ANALYZE (Critical)**:
- ✅ **API Contracts**: DTOs, interfaces, type definitions
- Public API endpoints (controllers, routes)
- Database schema changes
- Breaking changes in shared libraries
- Authentication/authorization changes
- Configuration changes affecting multiple services

**P1 - SHOULD ANALYZE (Important)**:
- Business logic implementation (services, use cases)
- State management changes (stores, contexts)
- New features and capabilities
- Error handling and validation logic
- Integration points with external services

**P2 - NICE TO HAVE (Optional)**:
- UI component updates (pure presentation)
- Refactoring without logic changes
- Test file updates
- Documentation updates
- Package dependency updates (non-breaking)

### File Selection Algorithm

#### Standard Algorithm (No Focus Specified)
From P0 files, select up to 5 most important:
1. Sort by: API contracts → Business logic → Infrastructure
2. Within each tier, pick files with most changes (lines changed)
3. Ensure coverage of: entry points, data flow, state management

From P1 files, select up to 3 if P0 < 3:
1. Focus on files interacting with P0 files
2. Business-critical paths

**Skip P2 files** unless P0+P1 < 3 total.

#### Focus-Based Algorithm (User Specified Focus)
When user specifies focus (e.g., "variables in pipelines"):

**Step 1: Boost Priorities Based on Focus**
```
For each changed file:
1. Assign base priority (P0/P1/P2)
2. IF file matches focus keywords → Boost to P0
3. IF file in focus directory → +1 level
4. IF file references focus entities → +1 level
5. Final priority = MIN(P0, base + boosts)
```

**Step 2: Search Broader Context**
Search beyond changed files for focus understanding:
```bash
# Search focus keywords in entire codebase
grep -r "focus_keyword" --include="*.ts" src/ | head -30

# Find all files in focus directory
find src/focus_directory -type f -name "*.ts" -o -name "*.tsx"

# Identify focus entity definitions
grep -l "class FocusEntity\|interface FocusEntity" --include="*.ts" src/
```

**Step 3: Map Relationships**
Identify related components that use/interact with focus entities:
- What imports focus entities? → Consumers
- What defines focus entities? → Definitions
- What modifies focus entities? → Mutators

**Step 4: Selection with Focus**
1. Select ALL focus-matching P0 files (even if >5)
2. If < 5 focus files, add non-focus P0 by standard rules
3. Add focus-matching P1 files (up to 3)
4. Include 1-2 context files (files that use focus entities)

**Example:** Focus = "variables in pipelines"
```
Selected files:
✅ P0: src/pipelines/variable-resolver.ts (focus match)
✅ P0: src/models/pipeline-variable.dto.ts (focus match)
✅ P1: src/pipelines/pipeline-runner.ts (context - uses variables)
✅ P1: src/services/variable-service.ts (focus match)
✅ P0: src/pipelines/pipeline-builder.ts (context - creates pipelines)
```

**Skip non-focus files** unless needed for context.

---

## Step 5: Deep Dive Protocol

**You CANNOT make conclusions from git diff alone. You MUST:**

1. **Read selected files**:
   - For small/medium files: read completely - no partial reads.
   - **CRITICAL**: For large files (> 500 lines), DO NOT read the entire file. First use code-outline (`view_file_outline`) or `grep_search` tools to locate the relevant classes or functions, then read only those specific line ranges using `view_file`.
2. **Understand context**:
   - How does this file fit in the architecture?
   - What are its dependencies?
   - What depends on it?
3. **Find and analyze tests**:
   - Look for test files matching changed files
   - Understand test coverage and scenarios
   - Identify edge cases being tested
4. **Check rules compliance**:
   - Verify against `code-style-patterns.mdc`
   - Check architecture patterns
   - Validate TypeScript usage

---

## Step 6: Cross-Repository Analysis (Source → Target)

**When analyzing external branch (e.g., backend) for implementation in target (e.g., frontend):**

### 6.1 Dependency Search in Target
Find all files in TARGET repo that:
- Import or use changed DTOs/APIs from SOURCE
- Reference modified endpoints
- Depend on changed business logic

### 6.2 Contract Divergence Analysis
Compare new contracts from SOURCE with current implementation in TARGET:
- Field additions/removals
- Type changes
- Endpoint modifications
- Behavior changes

### 6.3 Target Deep Dive
Read 2-3 key components in TARGET that will need changes:
- Understand current implementation patterns
- Identify MobX stores, React hooks, or services affected
- Check integration points

### 6.4 Target Rules Compliance
Verify TARGET repository guidelines:
- Check `.cursor/rules/core/*.mdc` in target repo
- Validate proposed changes against target patterns

---

## Step 7: UI Analysis (if applicable)

For UI changes, use Playwright/Storybook (see AGENTS.md for available tools):

### Check AGENTS.md for:
- `core/playwright-testing.mdc` - E2E test patterns
- `core/storybook-guidelines.mdc` - Component documentation
- Any UI testing skills in Skills Catalog

### Analyze:
- Visual regression requirements
- Component behavior changes
- Responsive design impact
- Accessibility considerations

---

## Step 8: Integration with Other Skills

**Leverage other skills via AGENTS.md catalog:**

Before finalizing analysis, consider running:
- `skills/code-style-review` - if architecture changes detected
- `skills/code-ai-review` - for self-validation of findings
- `skills/code-mobx-store-review` - if store changes found

**How to invoke:**
1. Reference `AGENTS.md` Skills Catalog
2. Select appropriate skill based on findings
3. Run skill with context from current analysis
4. Incorporate findings into final report

---

## Step 9: Intermediate Review (CRITICAL)

After completing analysis, **SHOW USER** before generating full report:

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
3. [Brief finding 3]

Cross-Repo Impact:
- [ ] Breaking API changes detected
- [ ] New endpoints to implement
- [ ] DTO changes affecting frontend
- [ ] Database schema changes

Estimated Complexity: [Low/Medium/High]
Estimated Implementation Time: [hours/days]

Continue to full documentation? [Y/n]
- Type 'Y' to generate full report
- Type 'n' to adjust analysis scope
- Type 'questions' to ask about specific findings
═══════════════════════════════════════════════
```

Wait for user confirmation before proceeding.

---

## Step 10: Documentation Generation

### Output Structure
```
<DOCS_ROOT>/analysis/<feature-name>-<YYYY-MM-DD>/
├── README.md                    # Index and navigation
├── report/
│   ├── en/
│   │   └── report.md           # English for humans
│   ├── ru/
│   │   └── report.md           # Russian for humans
│   └── ai/
│       └── report.md           # Structured for AI agents (EN)
├── plans/
│   ├── en/
│   │   └── implementation-plan.md
│   ├── ru/
│   │   └── implementation-plan.md
│   └── ai/
│       └── implementation-plan.md  # Gherkin-style format
├── contracts/
│   ├── api-changes.md          # API contract diff
│   └── dto-comparison.md       # Before/after DTOs
└── metrics/
    └── analysis-metrics.md     # Analysis metadata
```

### AI-Readable Format (Gherkin-style)

For AI agent consumption in `report/ai/report.md` and `plans/ai/implementation-plan.md`.

**Purpose**: Enable other AI agents to parse analysis results programmatically and generate implementation plans.

**Structure Requirements**:

#### 1. Feature Declaration
```gherkin
Feature: [Concise Feature Name]
  As a [type of user]
  I want [goal]
  So that [benefit]
  
  Background:
    Given source repository is "[owner/repo]"
    And source branch is "[branch-name]"
    And target repository is "[owner/repo]"
    And target branch is "[branch-name]"
    And analysis date is "YYYY-MM-DD"
    And analysis version is "[version]"
```

#### 2. Metadata Scenario (Required)
```gherkin
  Scenario: Analysis Metadata
    Given the analysis scope
    Then the following metadata is captured:
      | Field | Value |
      | BASE_SHA | [commit-hash] |
      | Parent Branch | [origin/main] |
      | Files Analyzed | [N] |
      | P0 Files | [N] |
      | P1 Files | [N] |
      | Complexity Score | [N] |
      | Risk Level | [Low/Medium/High] |
```

#### 3. API Contract Scenarios (One per changed endpoint)
```gherkin
  Scenario: API Contract - [Endpoint Name]
    Given the endpoint "[METHOD /path/to/resource]"
    And the endpoint purpose is "[business purpose]"
    When comparing contracts between source and target
    Then the request changes are:
      | Field | Type | Required | Description |
      | [field] | [type] | [Y/N] | [desc] |
    And the response changes are:
      | Field | Type | Required | Description |
      | [field] | [type] | [Y/N] | [desc] |
    And breaking changes are "[Y/N]"
    And backward compatibility is "[Y/N]"
    Examples:
      | Version | Change Type |
      | old | [before state] |
      | new | [after state] |
```

#### 4. Business Logic Scenarios (One per P0 file)
```gherkin
  Scenario: Business Logic - [File Name]
    Given the file "[path/to/file.ts]"
    And the file purpose is "[purpose description]"
    When analyzing the implementation
    Then the following functions/methods are present:
      | Name | Purpose | Input | Output |
      | [name] | [purpose] | [input] | [output] |
    And the key logic includes:
      """
      [code snippet with comments]
      """
    And the business rules are:
      1. [rule 1]
      2. [rule 2]
    And the edge cases handled are:
      | Case | Handling |
      | [case] | [how handled] |
```

#### 5. State Management Scenarios (if applicable)
```gherkin
  Scenario: State Management - [Store Name]
    Given the MobX store "[StoreName]"
    And the store manages "[what state]"
    Then the observables are:
      | Name | Type | Initial Value |
      | [name] | [type] | [value] |
    And the actions are:
      | Name | Purpose | Async |
      | [name] | [purpose] | [Y/N] |
    And the computed values are:
      | Name | Dependencies | Purpose |
      | [name] | [deps] | [purpose] |
```

#### 6. Cross-Repository Impact Scenarios
```gherkin
  Scenario: Cross-Repository Impact - [Component/Service]
    Given the target component "[path/to/component.tsx]"
    And it depends on source API "[endpoint]"
    When the API changes are applied
    Then the following changes are required:
      | Location | Change Type | Description |
      | [file] | [modify/add/remove] | [desc] |
    And the migration steps are:
      1. [step 1]
      2. [step 2]
    And the risk level is "[Low/Medium/High]"
```

#### 7. Implementation Plan (in plans/ai/)
```gherkin
Feature: Implementation Plan for [Feature Name]
  Background:
    Given analysis from "[path/to/analysis]"
    And target repository is "[owner/repo]"
  
  Scenario: Phase 1 - Setup and Dependencies
    Given the current state of target repository
    Then install/update the following dependencies:
      | Package | Version | Purpose |
      | [pkg] | [ver] | [purpose] |
    And configure the following:
      | Config | Value |
      | [key] | [value] |
  
  Scenario: Phase 2 - API Layer Implementation
    Given the API contract changes
    Then implement the following files:
      | File | Purpose | Key Methods |
      | [path] | [purpose] | [methods] |
    And update DTOs:
      | DTO | Changes |
      | [name] | [changes] |
  
  Scenario: Phase 3 - Business Logic Implementation
    Given the business requirements
    Then implement:
      """
      [pseudo-code or code structure]
      """
    And handle edge cases:
      | Case | Implementation |
      | [case] | [solution] |
  
  Scenario: Phase 4 - UI Integration
    Given the UI requirements
    Then update components:
      | Component | Changes |
      | [name] | [desc] |
  
  Scenario: Phase 5 - Testing
    Given the implementation
    Then write tests for:
      | Type | Coverage |
      | Unit | [what to test] |
      | Integration | [scenarios] |
    And verify:
      | Check | Expected |
      | [check] | [result] |
  
  Scenario: Verification and Rollout
    Given all phases complete
    Then verify:
      | Check | Command/Method |
      | Build | npm run build |
      | Tests | npm test |
      | Lint | npm run lint |
    And deploy to:
      | Environment | Steps |
      | [env] | [steps] |
```

#### Gherkin Syntax Rules:
- Use **Given** for preconditions and context
- Use **When** for actions or analysis steps
- Use **Then** for expected outcomes and validations
- Use **And/But** to continue previous statement
- Use **Examples** for tabular data variations
- Use **"""** for multi-line text (code snippets)
- Use **|** for tables with headers
- Keep scenarios focused and atomic (one concept per scenario)
- Use descriptive names: "API Contract - User Creation Endpoint" not "Scenario 1"

---

## Step 11: Content Requirements

### Evidence-Based Documentation
- Every claim MUST reference specific code
- Use format: `[filename.ts:L123](file:///absolute/path#L123)`
- Minimum 3 code examples in report

### Visualization
- Mermaid diagrams for architecture
- Tables for DTO changes
- Flowcharts for data flow changes

### Multi-Language Support
- **report/en/**: Full detail for humans
- **report/ru/**: Full detail for humans (Russian)
- **report/ai/**: Gherkin-style for AI agents (English)

---

## Step 12: Error Handling and Fallbacks

### GitHub MCP Unavailable
```markdown
**Status**: GitHub MCP not responding
**Fallback**: Using git history and commit messages only
**Impact**: Limited business context
**Action**: Ask user to restart MCP or proceed with limited analysis
```

### No Tests Found
```markdown
**Warning**: No test files found for analyzed components
**Risk**: Untested logic may have edge cases
**Recommendation**: Add test coverage for critical paths
```

### Cannot Determine BASE_SHA
```markdown
**Strategy 1**: Ask user for parent branch name
**Strategy 2**: Use `git log --first-parent` to estimate
**Strategy 3**: Analyze only HEAD commit (limited scope)
```

### Empty Diff
```markdown
**Check 1**: Staged changes only? `git diff --cached`
**Check 2**: Untracked files? `git status`
**Check 3**: Wrong branch? `git branch -a`
```

### Cross-Repo Access Denied
```markdown
**Status**: Cannot access target repository
**Options**:
1. Provide target repo path manually
2. Skip cross-repo analysis (source-only)
3. Export analysis for manual review
```

---

## Step 13: Analysis Metrics

Track and report:

```markdown
## Analysis Metrics

- **Duration**: [X minutes]
- **Files Analyzed**: [N total] (P0: [N], P1: [N], P2: [N])
- **Lines of Code Changed**: [N]
- **Cross-Repo Dependencies**: [N files affected]
- **API Endpoints Changed**: [N]
- **DTOs Modified**: [N]
- **Breaking Changes**: [Y/N, count]
- **Test Coverage**: [% or N/A]
- **Risk Level**: [Low/Medium/High]
- **Estimated Effort**: [X hours/days]

## Complexity Score
Calculate: (P0_files × 3) + (P1_files × 2) + (P2_files × 1) + (breaking_changes × 5)
- 0-10: Low complexity
- 11-25: Medium complexity
- 26+: High complexity
```

---

## Step 14: Validation Checklist

Before finalizing, verify:

```markdown
## Pre-Delivery Checklist

- [ ] Source repository fully analyzed (all P0 files)
- [ ] Target repository analyzed (if cross-repo)
- [ ] Minimum 3 code examples included
- [ ] All file references include line numbers
- [ ] API contracts documented (if applicable)
- [ ] Breaking changes clearly identified
- [ ] Implementation plan provided
- [ ] Metrics calculated and documented
- [ ] Multi-language reports generated (EN, RU, AI)
- [ ] User approved intermediate review
- [ ] AGENTS.md updated if new patterns discovered
```

---

## Step 15: Post-Analysis

### Update Documentation Registry
Follow `documentation-management.mdc`:
- Update `<DOCS_ROOT>/readme.md`
- Add entry to analysis index
- Tag with relevant keywords

### Archive Old Analyses
User manages cleanup manually, but suggest:
```
Tip: Consider archiving analyses older than 3 months to:
<DOCS_ROOT>/analysis/archived/
```

---

## Rules and Guidelines

1. **Always follow** `documentation-management.mdc` for doc structure
2. **Always check** `code-style-patterns.mdc` for compliance
3. **Always use** AGENTS.md to discover available skills and tools
4. **Never assume** - ask user when unclear
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

# Feature Analyzer — Extended Documentation

> This file contains detailed supplementary documentation for `feature-analyzer`.
> For the core workflow, guard clause, and step-by-step checklist, see `SKILL.md`.

---

## User-Specified Analysis Focus — Detailed

When user specifies a focus area (e.g., "analyze everything related to variables in pipelines"):

### Focus Keywords Priority System

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

### Focus-Based Selection with Examples

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

**Example result:** Focus = "variables in pipelines"
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

## Mode B: Feature Formalization (Current State Analysis)

When user does NOT provide base-branch, **formalize existing functionality** instead of analyzing changes.

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
│   ├── en/feature-specification.md
│   ├── ru/feature-specification.md
│   └── ai/feature-specification.md
├── architecture/
│   ├── data-flow.md
│   ├── component-diagram.md
│   └── api-contracts.md
├── usage/
│   ├── examples.md
│   └── patterns.md
└── tests/
    └── test-coverage.md
```

---

## Timeouts and Limits

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

**Metadata file:** `<DOCS_ROOT>/analysis/.cache/index.json`

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

## Analysis Mode Decision Tree (Detailed)

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

### Example Context Gathering Conversation

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

## Step 3: BASE_SHA Calculation Algorithm (Full)

**The base branch MUST be determined from the last branching point (merge-base), NOT from the current HEAD of the parent branch.**

This ensures you analyze only the changes made in the feature branch, not changes that occurred in the parent branch after the feature was branched.

**Why this matters:**
- If you compare against `origin/main` HEAD, you'll see unrelated changes from other merged PRs
- You MUST find the exact commit where the feature branch diverged
- Use `git merge-base` to find this point

### Calculate BASE_SHA

**ALGORITHM — Find the last branching point:**

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

# Step 2: CRITICAL — Find the actual branching point (merge-base)
# This gives you the commit where feature branch diverged from parent
BASE_SHA="$(git merge-base HEAD "$PARENT")"
```

**Verification:**
```bash
echo "Feature branch: $BRANCH"
echo "Parent branch: $PARENT"
echo "Branching point (BASE_SHA): $BASE_SHA"
echo "Commits in feature branch:"
git log --oneline "${BASE_SHA}..HEAD"
```

**Result:** `BASE_SHA` is the exact commit where your feature branch started.

---

## Step 10: Gherkin Output Format (Full)

The AI-readable format in `report/ai/report.md` and `plans/ai/implementation-plan.md` uses Gherkin-style scenarios.

**Purpose**: Enable other AI agents to parse analysis results programmatically.

### 1. Feature Declaration
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

### 2. Metadata Scenario (Required)
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

### 3. API Contract Scenarios (One per changed endpoint)
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

### 4. Business Logic Scenarios (One per P0 file)
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

### 5. State Management Scenarios (if applicable)
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

### 6. Cross-Repository Impact Scenarios
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

### 7. Implementation Plan (in plans/ai/)
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

### Gherkin Syntax Rules:
- Use **Given** for preconditions and context
- Use **When** for actions or analysis steps
- Use **Then** for expected outcomes and validations
- Use **And/But** to continue previous statement
- Use **Examples** for tabular data variations
- Use `"""` for multi-line text (code snippets)
- Use `|` for tables with headers
- Keep scenarios focused and atomic (one concept per scenario)
- Use descriptive names: "API Contract - User Creation Endpoint" not "Scenario 1"

---

## Step 13: Full Metrics and Complexity Score

Track and report in `metrics/analysis-metrics.md`:

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

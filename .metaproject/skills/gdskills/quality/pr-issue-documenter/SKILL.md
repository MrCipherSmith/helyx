---
name: pr-issue-documenter
description: "Use when documenting PR changes, adding a PR description, creating a linked issue for a PR, or updating an existing issue body."
triggers:
  - "Add PR description"
  - "Document PR changes"
  - "Describe what was done in PR"
  - "Create issue for PR"
  - "Update PR and issue"
  - "Add description to PR"
  - "Write PR summary"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "documentation"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# PR & Issue Documenter

## Purpose

Analyzes PR commits and diffs to generate structured, accurate descriptions for GitHub PRs and linked issues. Handles the full lifecycle: PR description, sub-issue creation, parent issue updates, and contradiction detection with existing descriptions.

**Input**: PR URL, issue URL, and/or commit SHAs
**Output**: Updated PR body, created/updated issue body, parent issue link

## When to Use

- User provides PR link and asks for a description
- User asks to document changes in a PR
- User wants to create an issue for a PR
- User wants to update an existing issue with PR changes
- User provides commit SHAs and wants documentation

## Architecture

```
Step 1: Parse Input
    |
Step 2: Collect Context (commits, diff, existing descriptions)
    |
Step 3: Analyze Changes (categorize, group, identify patterns)
    |
Step 4: Generate PR Description
    |
Step 5: Handle Issue (create / update / skip)
    |
Step 6: Apply Changes (gh pr edit, gh issue edit/create)
    |
Step 7: Verify & Report
```

## Workflow

Copy this checklist and track progress:

```
Task Progress:
- [ ] Step 1: Parse input — extract PR URL, issue URL, commit SHAs
- [ ] Step 2: Collect context — fetch commits, diff, existing descriptions
- [ ] Step 3: Analyze changes — categorize, group, build key files table
- [ ] Step 4: Generate PR description
- [ ] Step 5: Handle issue — create, update, or skip
- [ ] Step 6: Apply changes via gh CLI
- [ ] Step 7: Verify and report results to user
```

### Step 1: Parse Input

Extract from user message:
- **PR URL**: `https://github.com/owner/repo/pull/123` or `#123`
- **Issue URL**: `https://github.com/owner/repo/issues/456` or `#456`
- **Commit SHAs**: full or short SHA hashes

**Decision tree:**

```
IF PR URL provided:
  → Continue to Step 2

IF only commit SHAs provided (no PR):
  → ASK user: "Should I also create/update an issue, or just analyze the commits?"
  → If user provides issue link → continue with both
  → If user says skip → analyze commits only and present summary

IF only issue URL provided (no PR):
  → ASK user: "Please provide a PR URL or commit SHAs to analyze changes"

IF nothing provided:
  → ASK user: "Please provide a PR URL, issue URL, or commit SHAs"
```

### Step 2: Collect Context

Gather all necessary data:

**For PR:**
```bash
gh pr view {number} --json title,body,state,baseRefName,headRefName,commits
gh pr diff {number}
```

**For specific commits:**
```bash
git show {sha} --stat          # files changed
git show {sha} --format=""     # full diff
git log {sha} -1 --format="%H %s%n%b"  # commit message
```

**For existing issue (if provided):**
```bash
gh issue view {number} --json title,body,state
```

**For parent issue detection:**
- Check PR body for `Closes #N`, `Fixes #N`, `Parent issue: #N`
- Check issue body for `Parent issue: #N`
- If parent issue found, fetch its body too:
```bash
gh issue view {parent_number} --json title,body
```

### Step 3: Analyze Changes

Systematically analyze the collected diffs:

**3.1. Categorize each change:**
- `refactor` — restructuring without behavior change
- `feature` — new functionality
- `bugfix` — fixing broken behavior
- `cleanup` — removing dead code, unused imports
- `i18n` — translations, localization
- `test` — test additions/modifications
- `docs` — documentation changes
- `style` — formatting, naming, import ordering

**3.2. Group by logical area:**
- Identify related changes across files
- Group into named sections (e.g., "StepStore — Input/Output Consolidation")
- Each section should have a clear purpose statement

**3.3. Identify key patterns:**
- Deleted files (important to highlight)
- Renamed fields/methods (before → after)
- New APIs/interfaces
- Breaking changes
- Temporary/hardcoded values (mark for follow-up)

**3.4. Build Key Files table:**

| File | Change |
|------|--------|
| `path/to/file.ts` | Brief description |
| `path/to/deleted.ts` | **Deleted** |

### Step 4: Generate PR Description

Use this structure:

```markdown
## Summary

[2-3 sentences: WHAT was done, WHY it was done. Focus on the purpose, not individual changes.]

Closes #N

## Changes

### [Section Name 1]
- Bullet point describing specific change
- Another bullet point
- Use `code formatting` for identifiers

### [Section Name 2]
...

### Other
- Minor changes that don't warrant their own section

## Key Files

| File | Change |
|------|--------|
| `path/file.ts` | Brief description |
```

**PR description rules:**
- Summary: concise, 2-3 sentences max
- Changes: grouped by logical area, not by file
- Use backticks for code identifiers (`ClassName`, `methodName`, `fileName.ts`)
- Highlight deleted files with **Deleted** in bold
- Include `Closes #N` if issue is linked
- Key Files table: sorted by importance, not alphabetically

### Step 5: Handle Issue

**5.1. If issue URL was provided by user:**

Fetch existing issue body and compare with PR changes:

```
IF existing body is empty:
  → Generate full issue body and apply

IF existing body has content:
  → Check for contradictions:
    - Does the existing description claim something different from what the diff shows?
    - Are there sections that describe changes not present in the diff?
    - Are there changes in the diff not covered by existing sections?
  
  IF contradictions found:
    → Present contradictions to user
    → ASK: "I found contradictions in the existing issue description. Should I:
       1. Update the contradicting sections and add missing ones
       2. Replace the entire description
       3. Only append new sections"
    → Apply user's choice

  IF no contradictions (only missing sections):
    → Add new sections to existing body
    → Inform user what was added
```

**5.2. If no issue URL provided but PR is linked to a parent issue:**

```
ASK user: "PR is linked to parent issue #N. Should I:
  1. Create a sub-issue under #N with detailed description
  2. Link to an existing issue (provide number)
  3. Skip issue documentation"

IF user chooses to create sub-issue:
  → Generate issue title from changes
  → Generate detailed issue body (numbered sections, more detail than PR)
  → gh issue create
  → Update parent issue body with new sub-issue link
  → Update PR body with "Closes #NEW_ISSUE"
```

**5.3. If no issue URL and no parent issue detected:**

```
ASK user: "No linked issue found. Should I:
  1. Create a new issue for this PR
  2. Create a sub-issue under an existing parent (provide parent issue number)
  3. Skip issue documentation"
```

**Issue body format** (more detailed than PR):

```markdown
## Summary

[Same as PR summary but expanded with more context]

**PR**: #N
Parent issue: #M (if applicable)

---

## Changes

### 1. [Section Name]

[Detailed paragraph explaining what was changed and why]

- Specific bullet points with technical details
- Before → after descriptions for renames/refactors
- Code examples if helpful

### 2. [Section Name]
...

---

## Key Files

| File | Change |
|------|--------|
| `path/file.ts` | Description |
```

### Step 6: Apply Changes

Execute the changes via gh CLI:

```bash
# Update PR description
gh pr edit {number} --body "..."

# Update existing issue
gh issue edit {number} --body "..."

# Create new issue
gh issue create --title "..." --body "..."

# Update parent issue (append sub-issue link)
gh issue edit {parent_number} --body "..."
```

**Important:**
- Use heredoc (`cat <<'EOF'`) for body content to preserve formatting
- Always verify the result after each operation

### Step 7: Verify & Report

After all operations, report to the user:

```
Done. Here's what was created/updated:

- PR #N description updated: {url}
- Issue #M created/updated: {url}
- Parent issue #P updated with sub-issue link: {url}
```

## Contradiction Detection Rules

When comparing existing issue description with PR diff:

1. **Scope contradiction**: Description says change affects only X types, but diff shows it affects all types
2. **Field name contradiction**: Description uses old field name, diff shows it was renamed
3. **Missing sections**: Diff contains changes not described in any section
4. **Stale sections**: Description contains sections about changes not in the diff
5. **Required/optional contradiction**: Description says field is optional, diff shows it's required

Always present contradictions to user before making changes.

## Quality Standards

- PR description: concise, scannable, well-structured
- Issue description: detailed, comprehensive, with numbered sections
- Always use English for code documentation
- Never invent changes not present in the diff
- Always verify diff content before writing descriptions
- Group related changes logically, not by file
- Highlight breaking changes and deleted files prominently
- Mark temporary/hardcoded values for follow-up

## Error Handling

| Error | Action |
|-------|--------|
| PR not found | Ask user to verify PR number/URL |
| Issue not found | Ask user to verify issue number/URL |
| Commit SHA not found | Ask user to verify SHA |
| `gh` CLI not authenticated | Instruct user to run `gh auth login` |
| Empty diff | Inform user that PR has no file changes |
| Permission denied | Inform user they may not have write access |

## Rules of Engagement

1. **DO** analyze ALL commits in the PR, not just the latest one
2. **DO** check for contradictions before updating existing descriptions
3. **DO** ask user before overwriting existing issue content
4. **DO** update parent issue when creating sub-issues
5. **DO** include `Closes #N` in PR body when issue is linked
6. **DO NOT** invent or assume changes not visible in the diff
7. **DO NOT** silently overwrite existing issue descriptions
8. **DO NOT** create issues without user confirmation
9. **DO NOT** modify PR title unless explicitly asked
10. **DO NOT** write comments on GitHub PRs/issues (only edit body)

## Job Context Awareness

If called within an orchestrator job context, check for job context before starting:

```
IF JOB_NAME is provided AND .metaproject/jobs/<JOB_NAME>/ai/context.md exists:
  Read context.md — use it to understand the codebase, affected areas, and conventions
  This enriches PR description generation with project-specific knowledge
ELSE:
  Proceed with standard workflow (analyze PR/commits directly)
```

The job context path is: `<JOBS_ROOT>/<JOB_NAME>/ai/context.md`

---
name: pr-issue-documenter
description: "Analyzes PR commits/diff and generates structured descriptions for PRs and linked GitHub issues. Creates sub-issues, checks for contradictions with existing descriptions, updates parent issues."
triggers:
  - "Add PR description"
  - "Document PR changes"
  - "Create issue for PR"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "documentation"
license: "MIT"
compatibility: "cursor,codex,zed,opencode"
---

# PR & Issue Documenter

Analyzes PR commits/diff to generate structured descriptions for PRs and linked issues.

## Workflow

1. Parse input: extract PR URL, issue URL, commit SHAs. Ask if missing.
2. Collect context: `gh pr view`, `gh pr diff`, `git show`, `gh issue view`.
3. Analyze changes: categorize (refactor/feature/bugfix/cleanup/i18n/test), group by logical area, build key files table.
4. Generate PR description: Summary (2-3 sentences) + Changes (grouped sections) + Key Files table. Always English.
5. Handle issue: if provided, check contradictions and ask before overwriting; if not provided, ask whether to create sub-issue or skip.
6. Apply via `gh pr edit`, `gh issue edit/create`. Update parent issue if sub-issue created.
7. Report results with links.

## Key Rules

- Analyze ALL commits, not just the latest
- Check contradictions before updating existing issue descriptions
- Ask user before overwriting issue content
- PR description: concise. Issue description: detailed with numbered sections.
- Output language: English
- Never invent changes not in diff
- Never write comments on GitHub (only edit body)

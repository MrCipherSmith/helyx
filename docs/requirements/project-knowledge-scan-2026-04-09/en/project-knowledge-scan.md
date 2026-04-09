# PRD: Auto Project Scan on Registration

**Date:** 2026-04-09  
**Branch:** feat/project-knowledge-memory  
**Status:** Planned

---

## Overview

When a project is first registered (via `set_session_name` MCP tool or `/project_add` command), automatically scan the project directory and save key structural knowledge to long-term memory — without reading individual source files.

---

## Problem

When Claude Code starts a new session on an unfamiliar project, it has no pre-loaded context. It must rediscover the tech stack, entry points, and structure by exploring files. This wastes time and tokens on every new session.

A shallow one-time scan at registration can capture 80% of useful structural knowledge and make it available via `recall()` before any work begins.

---

## Goals

- On first project registration, read a small set of metadata files
- Generate 3–7 structured fact memories per project
- Make the scan idempotent: skip if project memories already exist
- Complete in < 5 seconds (no deep file traversal)

## Non-Goals

- Not scanning individual source files (too slow, too much noise)
- Not re-scanning automatically on every session (only on first registration)
- Not replacing Claude's own exploration during sessions

---

## Proposed Solution

### New function: `scanProjectKnowledge(projectPath)`

Location: `memory/project-scanner.ts` (new file)

**Files to read (in order, stop when found):**

| Priority | Files | Extract |
|----------|-------|---------|
| 1 | `README.md`, `README.*` | Project overview, purpose (first 2000 chars) |
| 2 | `package.json` | name, description, main, scripts, top 10 deps |
| 3 | `pyproject.toml`, `setup.py` | name, description, dependencies |
| 4 | `go.mod` | module name, go version, top deps |
| 5 | `Cargo.toml` | package.name, dependencies |
| 6 | Top-level directory listing | Filter out: node_modules, .git, dist, build, .cache |

**Skip if any of these exist as project memories:**
```sql
SELECT COUNT(*) FROM memories 
WHERE project_path = $path AND tags @> '["project"]'::jsonb AND type = 'fact'
```
If count > 0 → skip scan (already indexed).

**LLM synthesis step:**
Send collected raw data to Claude Haiku with prompt:
```
Given this project's metadata, generate 3-7 concise fact memories about the project.
Each memory should be:
- One sentence, under 150 characters
- About permanent structure (not session events)
- Tagged by category: stack, architecture, setup, conventions, entry-points

Format each as: [category] fact text
Example:
[stack] TypeScript + Bun runtime, grammY for Telegram, PostgreSQL with pgvector
[entry-points] Bot starts from main.ts; CLI tool is cli.ts; channel adapter is channel.ts
[setup] Requires Docker Compose for postgres; Ollama must run on host (not in container)
```

**Save each fact:**
```typescript
rememberSmart(fact, "fact", ["project", category], chatId=0, projectPath)
```

### Trigger points

**Option A: In `mcp/tools.ts:set_session_name` handler**
```typescript
// After session is adopted/registered:
const hasKnowledge = await checkProjectKnowledge(projectPath);
if (!hasKnowledge) {
  scanProjectKnowledge(projectPath).catch(console.error); // non-blocking
}
```

**Option B: In `/project_add` Telegram command**
After creating the remote session, trigger scan in background.

Both should be implemented.

### Files to change

| File | Change |
|------|--------|
| `memory/project-scanner.ts` | New file — `scanProjectKnowledge()` |
| `mcp/tools.ts` | Trigger scan after `set_session_name` (first registration only) |
| `bot/commands/project-add.ts` | Trigger scan after project creation |

---

## Data Model

Memory records created:
```
type:         "fact"
tags:         ["project", "<category>"]   // e.g. ["project", "stack"]
project_path: <project directory path>
content:      <one structural fact, ≤150 chars>
```

Categories: `stack`, `architecture`, `setup`, `conventions`, `entry-points`

---

## Acceptance Criteria

- [ ] On first `set_session_name` for a new project path, scan is triggered (async, non-blocking)
- [ ] On `/project_add`, scan is triggered for the registered path
- [ ] Scan is skipped if project already has fact memories with `["project"]` tag
- [ ] 3–7 fact memories created per project
- [ ] Scan completes in < 10 seconds for typical projects
- [ ] Scan failure does not block session registration
- [ ] Facts are retrievable via `recall("tech stack")`, `recall("how to run")`, etc.

---

## Open Questions

1. **Re-scan trigger**: How does a user force a re-scan after major project changes? Options: `/scan-project`, or drop all `["project"]` tagged facts and re-register.
2. **Large READMEs**: Cap at 2000 chars of README to keep LLM context manageable?
3. **Multiple package managers**: Projects with both `package.json` and `pyproject.toml` (monorepos)?
4. **Privacy**: Project metadata is sent to Anthropic API (Claude Haiku). Acceptable for all users?

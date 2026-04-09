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
WHERE project_path = $1
  AND tags @> ARRAY['project']
  AND archived_at IS NULL
```
If count > 0 → skip scan (already indexed).

**Manual re-scan** first archives existing records:
```sql
UPDATE memories SET archived_at = now()
WHERE project_path = $1
  AND tags @> ARRAY['project']
  AND archived_at IS NULL
```

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
// After adoptOrRename() resolves:
if (projectPath && session.id !== 0) {
  void scanProjectKnowledge(projectPath).catch((e) =>
    console.error("[project-scanner] scan failed:", e)
  );
}
```

**Option B: In `/project_add` Telegram command**
```typescript
// After registerRemote():
void scanProjectKnowledge(project.path).catch((e) =>
  console.error("[project-scanner] scan failed:", e)
);
```

Both are fire-and-forget (`void`, no `await`). Registration latency must not increase by more than 50ms.

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

1. **Re-scan trigger**: Manual re-scan via `/project_scan [path]` bot command + `scan_project_knowledge` MCP tool (archives existing records, runs fresh scan). Should both be implemented in the same PR?
2. **TOML parsing**: `pyproject.toml` and `Cargo.toml` require a TOML parser not in the project. Options: (a) add `smol-toml`; (b) regex-extract name/version only; (c) skip TOML manifests in first pass.
3. **Large READMEs**: Cap at 2000 chars, or extract only up to first `##` heading (more semantically precise)?
4. **Multiple package managers**: Projects with both `package.json` and `pyproject.toml` — read both or stop at first found?
5. **Standalone sessions**: Skip scan when `session.id === 0` (standalone). Confirmed: no project_path context exists.

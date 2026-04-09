# PRD: Claude-Driven Project Knowledge Saving

**Date:** 2026-04-09  
**Branch:** feat/project-knowledge-memory  
**Status:** Planned

---

## Overview

Make it natural and well-guided for Claude Code to proactively save project knowledge during sessions — by improving the `remember` tool description, adding guidance to CLAUDE.md, and adding a `/project-facts` command to review what Claude has learned.

---

## Problem

The `remember()` MCP tool already exists and Claude Code can call it at any time. However:

1. **No guidance**: Claude isn't told when or what to save. Sessions rely on the work summary at exit.
2. **Weak tool description**: The tool schema description doesn't explain the difference between saving a session event vs. durable project knowledge.
3. **No visibility**: Users can't easily see what project knowledge Claude has accumulated.
4. **No recall prompt**: Claude doesn't know to call `recall()` at session start to load prior project context.

---

## Goals

- Claude automatically saves important project discoveries during sessions, without user prompting
- Users can review accumulated project knowledge via bot command
- Session startup includes a context load step via `recall()`
- Tool schema clearly guides Claude on what to save

## Non-Goals

- Not automated pipeline (automated extraction is separate PRDs)
- Not enforcing that Claude saves everything (trust Claude's judgment)

---

## Proposed Solution

### 1. CLAUDE.md additions

Add to the project's `CLAUDE.md` (and optionally global `~/.claude/CLAUDE.md`):

```markdown
## Project Knowledge

Use the `remember` MCP tool to save important facts about the project when you discover them.
Save things that are non-obvious, easy to forget, or would help future sessions start faster.

Good candidates for saving:
- Architectural constraints ("Port 3847 serves both MCP and dashboard — same HTTP server")
- Non-obvious setup requirements ("downloads/ must be pre-created — Docker creates it as root")
- Important conventions ("migrations are append-only — never modify existing migration SQL")
- Key file roles ("mcp/bridge.ts handles permission forwarding from Claude Code to Telegram")
- Gotchas and known issues ("Ollama must run on host, not in Docker container")

Use type="fact", tags=["project", "<category>"] where category is one of:
  architecture, stack, setup, conventions, entry-points, gotchas

At the start of a session on a project you haven't worked on recently, call:
  recall("project architecture") and recall("project setup")
to load prior context before starting work.
```

### 2. `remember` tool schema improvement

Update the tool description in `mcp/tools.ts` and `channel.ts`:

**Current description:**
```
"Save a fact to long-term memory"
```

**New description:**
```
"Save a durable fact or decision to long-term memory. Use this for:
- Project architecture facts (file roles, architectural decisions, constraints)  
- Setup requirements and gotchas
- Project conventions and patterns
- Things that would be useful to know at the start of future sessions.
Use type='fact' for project knowledge, type='decision' for architectural decisions,
type='note' for temporary observations. Tag with ['project', '<category>'] for project facts."
```

### 3. New bot command: `/project-facts [project_name]`

Show all fact memories tagged `["project"]` for the current or specified project:

```
📚 Project Knowledge — claude-bot

[architecture]  Port 3847 serves both MCP server and dashboard — same HTTP server
[setup]         downloads/ must be pre-created by user — Docker creates it as root:root
[conventions]   Migrations are append-only — never modify existing SQL
[entry-points]  Bot: main.ts | CLI: cli.ts | Channel adapter: channel.ts
[gotchas]       Ollama must run on host, not in Docker container (host.docker.internal)

5 facts — last updated 2h ago
[🗑 Clear all] [+ Add fact]
```

Implementation: `bot/commands/project-facts.ts` (new file), query memories by `project_path + tags @> '["project"]'`.

### 4. Session startup recall (CLAUDE.md instruction)

Already covered by CLAUDE.md addition above. No code change needed — Claude follows CLAUDE.md instructions.

### Files to change

| File | Change |
|------|--------|
| `CLAUDE.md` | Add Project Knowledge section with guidance |
| `mcp/tools.ts` | Improve `remember` tool description |
| `channel.ts` | Improve `remember` tool description in ListToolsRequestSchema |
| `bot/commands/project-facts.ts` | New file — `/project-facts` command handler |
| `bot/bot.ts` | Register `/project_facts` command |
| `guides/memory.md` | Add section on project knowledge |

---

## Acceptance Criteria

- [ ] CLAUDE.md contains clear guidance on when and what to save with `remember()`
- [ ] `remember` tool description in both `mcp/tools.ts` and `channel.ts` is updated
- [ ] `/project-facts` command lists all `["project"]`-tagged memories for current project
- [ ] `/project-facts <path>` works for a specific project path
- [ ] Inline delete button per fact in the `/project-facts` list
- [ ] `guides/memory.md` documents project knowledge feature

---

## Open Questions

1. **Global vs project CLAUDE.md**: Should the guidance go in the project's `CLAUDE.md` (affects only this bot project) or the user's global `~/.claude/CLAUDE.md` (affects all projects)? Probably both — global for general guidance, project-specific for examples.
2. **Auto-recall on startup**: Should the channel adapter automatically call `recall("project")` on startup and inject results as system context? This would be more reliable than relying on Claude to remember to do it.
3. **Fact decay**: Should project facts have longer TTL than the default `fact` TTL (90 days)? Project architecture doesn't change often.

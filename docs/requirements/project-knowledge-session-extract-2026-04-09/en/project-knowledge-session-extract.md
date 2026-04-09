# PRD: Session-End Project Knowledge Extraction

**Date:** 2026-04-09  
**Branch:** feat/project-knowledge-memory  
**Status:** Planned

---

## Overview

At the end of a Claude Code session, after the existing work summary, run an additional LLM pass to extract *reusable project knowledge* (not session-specific facts) and save it to long-term memory.

---

## Problem

The existing `summarizeWork()` creates a `project_context` memory that captures what happened during a session: decisions made, files changed, problems solved, pending tasks. This is temporal — it's about the session, not the project.

There is no mechanism to extract durable project facts from sessions: architectural constraints, non-obvious file roles, important conventions, setup quirks. This knowledge exists in messages and tool calls but is lost when the session ends.

---

## Goals

- Extract project facts from session history that will be useful in future sessions
- Save them as searchable long-term memories scoped by `project_path`
- Avoid duplication (use existing smart reconciliation)
- No user action required — runs automatically on session exit

## Non-Goals

- Not a replacement for the existing work summary (both run)
- Not indexing all source files (that's a separate PRD)
- Not extracting session-specific events ("today I fixed bug X")

---

## Proposed Solution

### New function: `extractProjectKnowledge(sessionId, projectPath)`

Location: `memory/summarizer.ts` (alongside `summarizeWork`)

**Flow:**
1. Fetch last N messages for the session (same context as summarizeWork)
2. Include the just-generated work summary as additional context
3. Run LLM call (Claude Haiku) with extraction prompt:
   ```
   Given the following session transcript and work summary, extract durable project knowledge facts.
   Rules:
   - Facts must be true about the project in general, not just this session
   - Each fact under 150 characters
   - Format: one fact per line, no bullet points
   - Skip facts already implied by the work summary
   - 0-8 facts maximum; return empty if nothing durable to extract

   Examples of good facts:
   - "Port 3847 serves both MCP server and dashboard — same HTTP server"
   - "downloads/ must be pre-created by user before Docker starts"
   - "migrations are append-only — never modify existing migration SQL"

   Examples of bad facts (session-specific):
   - "Fixed voice download bug today"
   - "Added react tool to channel.ts"
   ```
4. Parse response → split by newlines → filter empty/short lines
5. For each fact: call `rememberSmart(fact, "fact", ["project", "learned"], chatId, projectPath)`
   - Smart reconciliation deduplicates against existing memories

### Trigger point

In `channel.ts`, after `summarizeWork()` call:
```typescript
await summarizeWork(sessionId, chatId, projectPath);
await extractProjectKnowledge(sessionId, chatId, projectPath); // new
```

Or in the `/api/sessions/:id/summarize-work` route handler.

### Files to change

| File | Change |
|------|--------|
| `memory/summarizer.ts` | Add `extractProjectKnowledge()` function |
| `channel.ts` | Call `extractProjectKnowledge()` on exit, after `summarizeWork()` |
| `api/sessions/route.ts` | If summarize-work is a route handler, call extraction there too |

---

## Data Model

Memory records created:
```
type:         "fact"
tags:         ["project", "learned"]
project_path: <session project_path>
content:      <one extracted fact, ≤150 chars>
```

Smart reconciliation handles deduplication via `rememberSmart()`.

---

## Acceptance Criteria

- [ ] On session exit, `extractProjectKnowledge()` is called after `summarizeWork()`
- [ ] 0–8 new fact memories created per session (never more)
- [ ] Facts are scoped by `project_path` and searchable via `recall()`
- [ ] Duplicate facts are not created (reconciliation handles it)
- [ ] If LLM call fails, session exit is not blocked (graceful error handling)
- [ ] Empty result (0 facts) is a valid outcome — no error logged

---

## Open Questions

1. **LLM cost**: Each session exit = 1 extra Haiku call. Acceptable? Could be gated by config flag `EXTRACT_PROJECT_KNOWLEDGE=true`.
2. **Minimum session length**: Should we skip extraction for very short sessions (< 5 messages)? Probably yes.
3. **Which messages**: Use last 50 messages? Full session? Summarized context?
4. **Fact quality**: How do we validate quality over time? Maybe a `/project-facts` command to review.

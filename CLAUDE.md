# CLAUDE.md

## Project Knowledge: Save and Load

### Session start
At the beginning of any session where you will do significant work on this codebase,
call `search_project_context(query="project architecture constraints conventions")`
to load facts saved in previous sessions. Read the results before exploring source files.

### During work — save facts proactively
Call `remember(type="fact", tags=["project", "<category>"])` when you discover anything
a future Claude session should know:

- Architecture decisions and why they were made
- Non-obvious constraints (hardcoded ports, required env vars, ordering dependencies)
- Important file roles that are not obvious from the name
- Setup quirks (e.g. "downloads/ must be pre-created before Docker starts")
- Naming or coding conventions specific to this project
- Gotchas you encountered

Write facts as self-contained sentences — assume the future reader has no context from
this session.

Good: `"channel.ts pre-registers MCP sessions before Claude Code connects to avoid a race condition on startup"`
Bad: `"fixed bug in channel.ts today"`

Categories: `architecture`, `stack`, `setup`, `conventions`, `entry-points`, `gotchas`

### What NOT to save
- Transient task state ("I just edited X")
- Things already documented in source comments or README
- Per-session events (use type="project_context" for those, they are handled automatically)

---

## Autonomous Loop Behavior

When woken by the autonomous loop (`<<autonomous-loop>>`), **do NOT send greetings** like "На связи. Что нужно?" or "I'm here, what do you need?". Instead, run a silent health check and only notify if something requires attention.

### Health check procedure (on each autonomous wakeup)

1. Call `list_sessions` — check that active sessions are present and not stale.
2. Call `docker_container_list` — verify helyx container is running.
3. If **everything is healthy** → do nothing, send no message.
4. If **something is wrong** → call `reply` with a concise alert:

```
⚠️ Helyx health check:
- Sessions: <status>
- Docker: <status>
- Action needed: <what to do>
```

**Never send a message just to say you woke up.** Only send if there is an actionable problem.

---

## Deployment Rules

**NEVER restart Docker containers or run any of these without explicit user confirmation:**
- `docker compose restart`
- `docker compose up` / `docker compose down`
- Any service restart or rebuild that causes downtime

After `docker compose build` completes, STOP and say:
> "Build ready — restart when you're ready, I'll wait for your go-ahead."

Do not proceed automatically, even in orchestrator/parallel-agent flows where the next logical step is restart. Always checkpoint before any action that disrupts the running service.

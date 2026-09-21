---
type: agent-entrypoint-rule
priority: high
source: "CLAUDE.md"
version: "1.0.0"
generated_by: keryx
---

# Imported Rules: CLAUDE.md

Source: `CLAUDE.md`
Priority: `high`
Version: `1.0.0`

This file is generated from the repository root agent entrypoint. Edit `CLAUDE.md`, then rerun `keryx rules sync`.

---

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

## Code Review with Reviewers

When the user asks for a code review, PR review, or analysis of changes in this codebase, **run all enabled independent reviewers in parallel** instead of reviewing the changes yourself.

### When to invoke

Trigger phrases (in any language):
- "сделай ревью", "review", "проверь код", "code review", "посмотри PR", "review PR"
- "что изменилось", "проанализируй изменения", "check my changes"

### How to invoke

Run the review pipeline via the shell:

```bash
bun scripts/review.ts "<review request>"
```

Pass the user's original request as the prompt. The pipeline runs every enabled
reviewer concurrently (by default: Codex and the configured provider model,
e.g. DeepSeek v4-pro) and prints each report. Reviewers are configured in
Telegram with underscore-separated commands: `/reviewers` alone lists them,
`/reviewers_add` adds one (`/reviewers_add provider DeepSeek deepseek-v4-pro`),
`/reviewers_remove <id>` removes one, `/reviewers_status` checks availability,
and `/reviewers_default` resets to the default set. Each provider model reads
the git diff itself from the prompt.

If a reviewer prints `[<label>] unavailable: ...` — that reviewer is down
(rate limit / balance / auth). Deliver the reports of the ones that succeeded.

### Fallback if all reviewers fail

If the pipeline prints the single line `SELF` — every reviewer is down — **do the
review yourself** using the native code-review skill (`git diff` + code-review
skill). Do NOT mention the reviewers or that a fallback happened unless the user
asks. Just deliver the review.

### Example

User: "сделай ревью последних изменений"
You: run `bun scripts/review.ts "review the latest changes on this branch"` and relay the output.
If it prints `SELF` → do the review yourself using `git diff` + code-review skill.

---

## Implementation Rules

**NEVER write or modify code based on a discussion or question.** Exploratory messages ("хочу рассмотреть возможность", "можно ли сделать", "давай начнем с", "как бы ты это сделал") are discussions — respond with a plan or options, then **wait for explicit confirmation** before touching any files.

Explicit go-ahead phrases: "реализуй", "сделай", "пиши", "внедри", "давай", "go ahead", "implement it", "do it".

If unsure — ask: "Реализовать?" before proceeding.

---

## Deployment Rules

**NEVER restart Docker containers or run any of these without explicit user confirmation:**
- `docker compose restart`
- `docker compose up` / `docker compose down`
- Any service restart or rebuild that causes downtime

After `docker compose build` completes, STOP and say:
> "Build ready — restart when you're ready, I'll wait for your go-ahead."

Do not proceed automatically, even in orchestrator/parallel-agent flows where the next logical step is restart. Always checkpoint before any action that disrupts the running service.

### What "перезапусти" actually means — read this before running anything

The system has **two halves**, and almost every restart command touches only one
of them. Twice now an agent asked "перезапускаю?", got "да", and ran a command
that restarted the half the user was not asking about — leaving the other half
dead with nothing saying so.

| Half | What it is | What restarts it |
|------|-----------|------------------|
| Containers | `helyx-bot-1`, `helyx-postgres-1` — the Telegram bot and the DB | `docker compose up -d [--build] bot` |
| Sessions | tmux windows running Claude Code, and the `channel.ts` MCP subprocess each one spawns | `bun cli.ts bounce` (kills the tmux session and starts the windows again) |

**Code that ships in the container does not reach a running session.** The
channel subprocess is started by the CLI on the host and lives as long as its
Claude Code session. Rebuilding the bot leaves every channel running the code it
was started with. If a change touches `channel/**`, `utils/status*`,
`utils/transcript*` or anything else the channel imports, the sessions **must**
be bounced or the change is not live — and the symptom is silence, not an error.

**Before running any restart command, say which half it restarts and confirm
that is the one meant.** One sentence: "Это перезапустит только контейнер бота;
сессии останутся на старом коде — бросать их тоже?" A bare "перезапускай" is not
enough information to pick a command; it is an instruction to restart *what was
just built*, which is usually both.

Command map — use these names, do not improvise:

| Intent | Command |
|--------|---------|
| Bring up whatever is down, break nothing that works | `stack_up` admin command, or 🚀 Поднять всё in `/system` |
| Ship new code everywhere | `full_restart` admin command (rebuild bot → bounce sessions), or ♻️ Полный рестарт |
| Only the bot container | `docker compose up -d --build bot` |
| Only the sessions | `bun cli.ts bounce`, or 🔄 Bounce |
| One project's session | `/projects` → stop/start, or the `proj_start`/`proj_stop` admin commands |
| Only the channel subprocesses | `channel_kill` admin command |

**`bounce`, `host_restart` and `full_restart` (the Telegram buttons and their
admin commands) take a file lease before they run** (`utils/restart-lease.ts`,
claimed via `claimRestart` in `scripts/admin-daemon.ts`). A second restart
started while one is in flight is refused with who holds it and how long ago,
instead of racing it — the lease expires after 15 minutes so a restart that
died without releasing does not lock the operator out permanently.

**That lease does not cover `bun cli.ts bounce` run directly on the host.**
The CLI's own `bounce` case (`cli.ts`, the `"bounce"` switch branch that calls
`tmuxStop()` then `tmuxStart()`) never calls `claimRestart`. Running it from a
terminal while a Telegram-triggered bounce or full restart is still in flight
can still race it exactly the way the lease exists to prevent. Prefer the
Telegram buttons or admin commands when a restart might overlap another one;
treat `bun cli.ts bounce` as the one path that still needs a human to check
nothing else is restarting first.

**Never leave the stack half-down.** `docker compose down`, `helyx stop` and
`tmux_stop` take things down and nothing brings them back on their own. If a
command in that family is run, the paired bring-up (`stack_up`) is part of the
same step, not a follow-up to be offered later.

**When the whole stack is down**, Telegram cannot reach the bot and the bot
cannot reach Postgres, so no button works. The way back in is `/up` sent to the
supervisor topic: the host daemon (`scripts/host-ingress.ts`) polls Telegram
directly whenever the bot is confirmed dead, and `/hstatus` reports what is
running from the host's own point of view.

# Configuring CLAUDE.md for Helyx

`CLAUDE.md` is the instruction file Claude Code reads at session start. Use it to configure automatic bot connection, status updates, and working rules.

## Where to place it

| Location | Scope |
|---|---|
| `~/.claude/CLAUDE.md` | Global — all projects |
| `<project>/CLAUDE.md` | This project only |

Both files are merged. Use the global one for shared settings (MCP, Telegram) and the project one for project-specific context (build commands, architecture).

---

## Minimum setup (required)

Add to your project or global `CLAUDE.md`:

```markdown
## MCP Integration

When starting a session, call `set_session_name` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory
```

This lets the bot identify the session and display it in `/sessions`.

---

## Telegram status updates (recommended)

Add this block so users can see what the CLI is doing in real time:

```markdown
## Telegram Status Updates

When responding to Telegram channel messages (messages from `notifications/claude/channel`), call `update_status` before each major step to keep the user informed. Use the `chat_id` from the channel message metadata.

Examples:
- Before reading files: `update_status(chat_id, "Reading files...")`
- Before running commands: `update_status(chat_id, "Running git status...")`
- Before editing: `update_status(chat_id, "Editing code...")`
- Before analysis: `update_status(chat_id, "Analyzing...")`

Keep status messages short (under 50 chars). The status is automatically deleted when you call `reply`.
```

---

## Commit rules (optional)

```markdown
## Git Commits

NEVER add "Co-Authored-By" or any co-authorship attribution in commit messages. Commit messages must contain only the description of changes.
```

---

## Full example — global `~/.claude/CLAUDE.md`

```markdown
# Global CLAUDE.md

## MCP Integration

When starting a session, call `set_session_name` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory

## Telegram Status Updates

When responding to Telegram channel messages (messages from `notifications/claude/channel`), call `update_status` before each major step to keep the user informed. Use the `chat_id` from the channel message metadata.

Examples:
- Before reading files: `update_status(chat_id, "Reading files...")`
- Before running commands: `update_status(chat_id, "Running git status...")`
- Before editing: `update_status(chat_id, "Editing code...")`
- Before analysis: `update_status(chat_id, "Analyzing...")`

Keep status messages short (under 50 chars). The status is automatically deleted when you call `reply`.

## Git Commits

NEVER add "Co-Authored-By" or any co-authorship attribution in commit messages.
```

---

## Full example — project `<project>/CLAUDE.md`

```markdown
# CLAUDE.md

## Project Overview

Brief description of the project, stack, and main directories.

## Common Commands

- `bun install` — install dependencies
- `bun dev` — start development server
- `bun test` — run tests

## Architecture

Architecture overview: modules, how they connect, key files.

## Code Style

- TypeScript strict mode
- Prefer async/await over callbacks
- Use named exports
```

---

## Available MCP tools

CLI sessions connect to the bot via two MCP servers:

### `helyx` (HTTP, shared)
| Tool | Description |
|---|---|
| `set_session_name` | Set session name (called automatically at startup) |
| `reply` | Send a message to Telegram |
| `react` | Set an emoji reaction on a message |
| `edit_message` | Edit a bot message |
| `remember` | Save to long-term memory |
| `recall` | Semantic search in memory |
| `forget` | Delete a memory entry |
| `list_memories` | List memory entries |
| `list_sessions` | List sessions |
| `session_info` | Current session info |

### `helyx-channel` (stdio, per-session)
| Tool | Description |
|---|---|
| `reply` | Send to Telegram (direct Bot API access) |
| `update_status` | Update status message in Telegram |
| `remember` | Save to memory |
| `recall` | Search memory |
| `forget` | Delete a memory entry |
| `list_memories` | List memory entries |

---

## Auto-approving MCP tools

To avoid Claude asking permission for every MCP call, add to `<project>/.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__helyx__*",
      "mcp__helyx-channel__*"
    ]
  }
}
```

Or add to the global `~/.claude/settings.local.json` to apply to all projects.

---

## Tips

- **Keep CLAUDE.md concise** — Claude reads it on every session start. Keep it short and relevant.
- **Use imperative instructions** — "Call X", "Never do Y", "Always check Z".
- **Commit the project CLAUDE.md** — the whole team gets consistent instructions.
- **Do not commit `settings.local.json`** — it contains personal settings (permissions, tokens).

# MCP Tools Reference

Helyx exposes MCP (Model Context Protocol) tools to Claude CLI. These tools are available in two configurations depending on how you connect.

---

## HTTP Server Tools

Available when Claude CLI connects via `helyx` HTTP MCP server (`http://localhost:3847/mcp`).

These tools work in any Claude session — with or without the channel adapter.

Parameters marked `?` are optional; everything else is required. Names are
`snake_case` throughout — the schemas are defined in `mcp/tools.ts`, not
camelCase as an earlier version of this doc claimed.

### Memory

| Tool | Parameters | Description |
|---|---|---|
| `remember` | `content`, `type?`, `tags?`, `source?` | Save a fact or decision to long-term memory with semantic embedding. `type`: `fact`, `summary`, `decision`, `note` (default `note`). `source`: `telegram`, `cli`, `api` (default `cli`). Uses smart reconciliation — won't duplicate existing memories. |
| `recall` | `query`, `limit?`, `type?`, `tags?` | Semantic search through project memories using pgvector. Returns ranked results by similarity; optionally filtered by type and tags. |
| `forget` | `id` | Delete a memory by ID. |
| `list_memories` | `type?`, `tags?`, `limit?`, `offset?` | List recent memories for the current project (default `limit` 20, `offset` 0). |
| `search_project_context` | `query`, `project_path?`, `limit?` | Semantic search specifically over project work summaries and prior session context. `project_path` defaults to the current session's. |

### Sessions

| Tool | Parameters | Description |
|---|---|---|
| `list_sessions` | — | List all sessions with status (active/inactive/terminated), source (remote/local/standalone), project, and last active time. HTTP-only — not registered on the channel adapter. |
| `session_info` | `session_id` | Get details for a specific session. |
| `set_session_name` | `name`, `project_path?` | Set the session name and register the project path. Called automatically by channel.ts on startup. |

### Communication

| Tool | Parameters | Description |
|---|---|---|
| `reply` | `chat_id`, `text`, `parse_mode?` | Send a message to the Telegram chat. `parse_mode`: `Markdown`, `MarkdownV2`, `HTML`. |
| `react` | `chat_id`, `message_id`, `emoji` | Set an emoji reaction on a Telegram message. |
| `edit_message` | `chat_id`, `message_id`, `text`, `parse_mode?` | Edit a previously sent bot message. |
| `send_photo` | `chat_id`, `url`, `caption?` | Send a photo to a Telegram chat. `url` is a public image URL or an absolute local file path. |

### Skills & Knowledge

| Tool | Parameters | Description |
|---|---|---|
| `scan_project_knowledge` | `project_path?`, `force_rescan?` | Scan a project directory and save structural knowledge (tech stack, architecture, entry points, setup) to long-term memory. `force_rescan` archives existing knowledge and rescans from scratch (default `false`). |
| `skill_view` | `name` | Load a skill and return its content with inline `` !`cmd` `` shell tokens expanded. |
| `propose_skill` | `transcript`, `name?`, `description?`, `body?` | Propose a new agent-created skill distilled from a session transcript; sends a Telegram approval message. |
| `save_skill` | `skill_id`, `approved` | Approve or reject a skill proposed by `propose_skill`. |
| `list_agent_skills` | — | List all active agent-created skills. |
| `curator_run` | — | Manually trigger a curator run to review agent-created skills. |
| `curator_status` | `limit?` | Get curator run history (default `limit` 10). |

---

## Channel Adapter Tools

Available when Claude CLI connects via `helyx-channel` stdio MCP server. The channel adapter (`channel/`) is a 10-file stdio bridge: `session.ts` (lifecycle), `permissions.ts` (Telegram forwarding), `tools.ts` (MCP dispatch), `poller.ts` (queue polling), `status.ts` (live status), `telegram.ts` (formatting), `recovery.ts` (redelivery of replies that never confirmed as sent), `reply-rule.ts` (the `reply` tool's State Matrix description), `skill-evaluator.ts` (agent-skill scoring), `index.ts` (entrypoint).

These tools run in the context of a specific session and have direct database access.

Almost every HTTP server tool is also available through the channel adapter — `list_sessions`, `session_info` and `set_session_name` are the exceptions, since those exist to manage sessions from outside one. A few shared tool names carry a smaller parameter set on this registry than on HTTP: `recall` here takes only `query`/`limit` (no `type`/`tags` filter), `remember` has no `source` field, and `propose_skill` takes only `name`/`transcript` (no `description`/`body`). Register definitions live in `channel/tools.ts`; check it directly before relying on a parameter this doc doesn't list.

Plus tools with no HTTP equivalent:

| Tool | Parameters | Description |
|---|---|---|
| `update_status` | `chat_id`, `status`, `diff?` | Update the live status message shown in Telegram while processing. Automatically deleted when `reply` is called. Optionally include a `diff` code block as a separate message. |
| `send_poll` | `chat_id`, `questions`, `title?` | Send one or more clarifying questions as native Telegram polls (2–10 options each). The user's answers flow back as a message once they tap "Готово ✅". |

### update_status usage

Call `update_status` before each major operation to keep the user informed:

```typescript
// Before reading files
update_status({ chat_id, status: "Reading files..." })

// Before running commands
update_status({ chat_id, status: "Running tests..." })

// Before analysis
update_status({ chat_id, status: "Analyzing..." })

// With a diff block
update_status({
  chat_id,
  status: "Editing code...",
  diff: "```diff\n- old line\n+ new line\n```"
})
```

Keep status messages under 50 characters. The status is automatically deleted when `reply` is called.

### Sub-agent progress updates

When launching multiple parallel agents, update status with a progress tree:

```
Running 3 agents...
├─ Agent name 1 — done
├─ Agent name 2 — done
└─ Agent name 3 — working...
```

---

## Permission State Machine

Permission requests flow through a formal state machine enforced by `PermissionService`:

```
pending → approved
        → rejected
        → expired
```

Terminal states (`approved`, `rejected`, `expired`) cannot transition again — duplicate Telegram callback deliveries are silently ignored. The bot replies "Already handled" to deduplicated callbacks.

Auto-approve rules stored in `settings.local.json`:
```json
{
  "permissions": {
    "allow": ["Edit(*)", "Bash(*)", "mcp__helyx__reply"]
  }
}
```

Pattern format:
- Native tools: `ToolName(*)` (e.g., `Edit(*)`, `Bash(*)`)
- MCP tools: exact tool name (e.g., `mcp__helyx__reply`)

---

## Health Endpoint

Not an MCP tool, but useful for monitoring:

```bash
GET http://localhost:3847/health
→ { "status": "ok", "db": "connected", "uptime": 3600, "sessions": 5 }
```

---

## Registration

MCP servers are registered in Claude Code via `helyx setup` or `helyx mcp-register`. You can also register manually:

```bash
# HTTP server
claude mcp add --transport http -s user helyx http://localhost:3847/mcp

# Channel adapter (per-session stdio)
claude mcp add-json -s user helyx-channel '{
  "type": "stdio",
  "command": "bun",
  "args": ["/path/to/helyx/channel.ts"],
  "env": {
    "DATABASE_URL": "postgres://helyx:helyx_secret@localhost:5433/helyx",
    "TELEGRAM_BOT_TOKEN": "your-bot-token"
  }
}'
```

To use the channel adapter, launch Claude with:
```bash
claude --dangerously-load-development-channels server:helyx-channel
```

---

## Shared MCP Services (playwright, context7)

playwright and context7 run as shared systemd HTTP services — one process for all sessions instead of one per session. RAM savings: ~4 GB with 8 active sessions.

→ [Full guide: Shared MCP Services](shared-mcp-services.md)

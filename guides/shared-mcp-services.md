# Shared MCP Services

Helyx runs `playwright-mcp` and `context7-mcp` as **shared systemd user services** instead of per-session stdio subprocesses. This reduces MCP RAM overhead from ~4+ GB to under 400 MB when 8+ sessions are active.

---

## The Problem

Claude Code with stdio transport forks a dedicated subprocess for each MCP server on every session start:

```
Session 1 → playwright-mcp  (own process, ~100 MB)
           → context7-mcp   (own process, ~90 MB)

Session 2 → playwright-mcp  (duplicate, ~100 MB)
           → context7-mcp   (duplicate, ~90 MB)
...× 8 sessions
```

With 8 sessions, this produces ~64 identical node processes consuming ~4.3 GB of RAM for servers that hold no per-session state.

---

## The Solution

Each server runs once as a systemd user service exposed over HTTP. All sessions connect to the shared instance:

```
systemd: mcp-playwright (:3011)  ← 1 process for all sessions
systemd: mcp-context7   (:3010)  ← 1 process for all sessions

Session 1 → http://localhost:3011/mcp
Session 2 → http://localhost:3011/mcp  (same instance)
...× 8 sessions
```

### Browser isolation (playwright)

playwright runs with `--isolated`, which gives each connecting session its own browser context — separate cookies, tabs, history — within a single process. Sessions do not interfere with each other.

### Stateless sharing (context7)

context7 is fully stateless (proxies documentation lookups with no session affinity), so it shares without any isolation mechanism.

---

## Services

| Service | Port | Flag | Notes |
|---------|------|------|-------|
| `mcp-playwright` | 3011 | `--isolated` | Per-connection browser context |
| `mcp-context7` | 3010 | `--transport http` | Fully stateless |

Service files: `~/.config/systemd/user/mcp-playwright.service`, `mcp-context7.service`

Registered in `~/.claude.json` via `claude mcp add --transport http`.

---

## RAM Impact

Measured with 8 active helyx-channel sessions:

| | Before | After |
|-|--------|-------|
| playwright processes | 24 | 3 |
| context7 processes | 24 | 3 |
| npm/npx wrappers | 48 | 0 |
| **MCP RSS total** | **~4.3 GB** | **~370 MB** |

---

## Setup

Installed automatically by `helyx setup` and `helyx mcp-register`.

### Manual install

```bash
# Services are started automatically on login
systemctl --user enable --now mcp-playwright mcp-context7

# Register HTTP endpoints in Claude Code
claude mcp add playwright --transport http -s user http://localhost:3011/mcp
claude mcp add context7  --transport http -s user http://localhost:3010/mcp
```

### Verify

```bash
# Service health
systemctl --user status mcp-playwright mcp-context7

# HTTP endpoints
curl -s http://localhost:3010/mcp   # context7
curl -s http://localhost:3011/mcp   # playwright

# Process count (should be 3 per service: npm exec + sh + node)
ps aux | grep -E "playwright-mcp|context7-mcp" | grep -v grep | wc -l

# RAM
ps aux | grep -E "playwright|context7" | grep -v grep \
  | awk '{sum+=$6} END {printf "MCP RSS: %.0f MB\n", sum/1024}'
```

### Logs

```bash
journalctl --user -u mcp-playwright -f
journalctl --user -u mcp-context7 -f
```

---

## Implementation Notes

**Config file:** `claude mcp` CLI writes to `~/.claude.json`, not `~/.claude/settings.json`. The `mcpServers` key in `settings.json` is a lower-priority fallback — always use the CLI to manage MCP registrations.

**external_plugins:** Claude Code also loads MCP configs from `~/.claude/plugins/.../external_plugins/*/mcp.json`. The playwright and context7 plugin entries are renamed to `.mcp.json.bak` during setup to prevent stdio duplication.

**docker-mcp:** `mcp-server-docker` (via uvx) does not support HTTP transport and stays on stdio. It is registered globally and runs as one process per session — acceptable overhead since it is lighter than playwright/context7.

# PRD: Migrate MCP Servers to Shared HTTP Transport

## 1. Overview

Migrate `playwright`, `context7`, and `docker-mcp` MCP servers from per-session stdio transport (one subprocess per session) to shared HTTP transport (one process for all sessions). Expected savings: up to **5.4 GB RAM** and reduction of MCP processes from ~90 to ~10.

---

## 2. Context

- **Product:** helyx — multi-session Telegram bot powered by Claude Code
- **Module:** Claude session infrastructure, MCP configuration
- **User Role:** server administrator / developer
- **Stack:** Ubuntu 24.04, Claude Code CLI, bun, systemd, Docker Compose
- **Server:** geekom, 28 GB RAM, 8 active helyx-channel sessions

---

## 3. Problem Statement

Claude Code with stdio transport forks dedicated subprocess MCP server instances for each open session. With 8 active helyx-channel sessions, this results in ~90 duplicate node processes:

- 16 `playwright-mcp` processes (822 MB)
- 24 `context7-mcp` processes (1,405 MB)
- 25 `docker-mcp-server` processes (1,340 MB)
- 25 `npm exec` wrapper processes (2,150 MB)

Total: **~5.7 GB** consumed by identical copies of stateless services.

---

## 4. Goals

- Reduce MCP process count from ~90 to ~10
- Reduce RAM consumption by ~5.4 GB
- Preserve full browser context isolation between sessions
- Add memory consumption monitoring for MCP processes

---

## 5. Non-Goals

- Optimizing Claude process memory (4.4 GB) — separate task
- Migrating helyx MCP (`http://localhost:3847/mcp`) — already on HTTP
- Optimizing bun processes and Docker containers
- Changing helyx-channel session logic or `run-cli.sh`

---

## 6. Functional Requirements

**FR-1:** Run `playwright-mcp` as an HTTP service on port 3011 with the `--isolated` flag (isolated browser contexts per session).

**FR-2:** Run `context7-mcp` as an HTTP service on port 3010 (`--transport http`).

**FR-3:** Research and run `docker-mcp-server` as an HTTP service on port 3012 (if supported).

**FR-4:** Create systemd user unit files for each MCP HTTP service with autostart under the `altsay` user.

**FR-5:** Update `~/.claude/settings.json` — replace stdio configs with HTTP URLs for all three servers.

**FR-6:** Research and resolve duplication: disable `external_plugins` for playwright and context7 if they conflict with `settings.json` entries.

**FR-7:** Restart all 8 helyx-channel sessions after applying the config.

**FR-8:** Measure RAM consumption and process count before and after.

---

## 7. Non-Functional Requirements

**NFR-1:** HTTP service startup time after system reboot — no more than 30 seconds.

**NFR-2:** Browser contexts of different sessions must not share state (`--isolated`).

**NFR-3:** Services must automatically restart on failure (`Restart=on-failure` in systemd).

**NFR-4:** MCP service logs must be written to journald and accessible via `journalctl`.

**NFR-5:** Total deployment time (including session restart) — no more than 10 minutes.

---

## 8. Constraints

- Claude Code does not support lazy MCP loading — HTTP services must be running **before** sessions start
- MCP config priority in Claude Code requires investigation (external_plugins vs settings.json)
- Downtime: all 8 sessions restart simultaneously (rolling restart not required)
- Ports 3010, 3011, 3012 must be free and not used by other services

---

## 9. Edge Cases

- `docker-mcp-server` does not support HTTP → leave on stdio, document separately
- external_plugins take priority over settings.json → must explicitly remove or override
- After session restart, old MCP stdio processes may remain as zombies → explicit `pkill` required
- HTTP service is down when session starts → Claude Code won't find tools, session degrades without browser

---

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: MCP servers on shared HTTP transport

  Scenario: playwright runs as a shared HTTP service
    Given systemd service mcp-playwright is running on port 3011
    When 8 helyx-channel sessions are opened
    Then exactly 1 playwright-mcp process exists
    And each session can use browser_navigate independently
    And browser context of session 1 is not visible to session 2

  Scenario: context7 runs as a shared HTTP service
    Given systemd service mcp-context7 is running on port 3010
    When 8 helyx-channel sessions are opened
    Then exactly 1 context7-mcp process exists
    And all sessions successfully retrieve documentation via context7

  Scenario: memory after fix
    Given all MCP HTTP services are running
    And 8 helyx-channel sessions are active
    When RSS measurement is taken
    Then total MCP process RSS is less than 500 MB
    And total server RAM consumption is less than 10 GB

  Scenario: fault tolerance
    Given mcp-playwright service is running
    When the playwright-mcp process crashes
    Then systemd restarts it within 5 seconds
    And new sessions regain access to the browser

  Scenario: browser context isolation
    Given playwright is running with --isolated flag
    And session A has navigated to example.com
    When session B calls browser_snapshot
    Then session B sees a blank browser, not session A's page
```

---

## 11. Verification

### How to verify

```bash
# MCP process count (should be ~3-5, not ~90)
ps aux | grep -E "playwright-mcp|context7-mcp|docker-mcp" | grep -v grep | wc -l

# RAM RSS before and after
ps aux | grep -E "playwright-mcp|context7-mcp|docker-mcp|npm exec" | grep -v grep \
  | awk '{sum+=$6} END {printf "MCP RSS: %.0f MB\n", sum/1024}'

# systemd service status
systemctl --user status mcp-playwright mcp-context7 mcp-docker

# HTTP endpoint availability
curl -s http://localhost:3010/mcp | head -5
curl -s http://localhost:3011/playwright | head -5

# Isolation check — via two different Claude sessions
# Session 1: browser_navigate("https://example.com")
# Session 2: browser_snapshot() — must show an empty page
```

### Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| MCP processes | ~90 | ~10 |
| MCP RSS | ~5.7 GB | < 500 MB |
| Total server RSS | ~14.5 GB | < 10 GB |

### Observability

- `journalctl --user -u mcp-playwright -f` — playwright logs
- `journalctl --user -u mcp-context7 -f` — context7 logs
- `systemctl --user status mcp-*` — service health

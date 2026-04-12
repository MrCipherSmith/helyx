# SPEC: mcp-http-transport

## metadata
```
feature_id: mcp-http-transport
date: 2026-04-12
status: approved
priority: high
effort: medium
scope: [playwright, context7, docker-mcp]
excluded: [helyx-mcp, bun-processes, claude-processes, docker-containers]
```

## problem
```
type: performance / resource-waste
root_cause: Claude Code stdio transport forks 1 MCP subprocess per session
sessions: 8 (helyx-channel)
affected_servers: [playwright-mcp, context7-mcp, docker-mcp-server]
current_process_count: ~90
current_rss_mb: 5700
target_process_count: ~10
target_rss_mb: <500
```

## solution
```
approach: replace stdio transport with HTTP transport
run_mode: systemd user services (altsay)
ports:
  context7: 3010
  playwright: 3011
  docker-mcp: 3012
playwright_flags: [--port 3011, --isolated]
context7_flags: [--transport http, --port 3010]
docker_mcp_flags: TBD (HTTP support to be verified)
```

## unknowns
```
- external_plugins priority vs settings.json: UNKNOWN — must be researched before implementation
- docker-mcp HTTP support: UNKNOWN — must be verified with --help or source
```

## config_change
```yaml
# ~/.claude/settings.json mcpServers section
# BEFORE (stdio — duplicated per session):
playwright:
  command: npx
  args: ["@playwright/mcp@latest"]

context7:
  command: npx
  args: ["-y", "@upstash/context7-mcp"]

# AFTER (HTTP — shared):
playwright:
  type: http
  url: http://localhost:3011/playwright

context7:
  type: http
  url: http://localhost:3010/mcp

docker:
  type: http
  url: http://localhost:3012/mcp   # if HTTP supported; else keep stdio
```

## systemd_units
```ini
# ~/.config/systemd/user/mcp-context7.service
[Unit]
Description=Context7 MCP HTTP Server
After=network.target

[Service]
ExecStart=npx -y @upstash/context7-mcp --transport http --port 3010
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target

---

# ~/.config/systemd/user/mcp-playwright.service
[Unit]
Description=Playwright MCP HTTP Server
After=network.target

[Service]
ExecStart=npx @playwright/mcp@latest --port 3011 --isolated
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

## deployment_steps
```
1. verify ports 3010/3011/3012 are free
2. verify docker-mcp HTTP support: npx @hypnosis/docker-mcp-server --help | grep -i http
3. create systemd unit files
4. systemctl --user daemon-reload
5. systemctl --user enable --now mcp-context7 mcp-playwright
6. verify HTTP endpoints respond
7. research external_plugins priority conflict
8. update ~/.claude/settings.json
9. pkill all existing MCP stdio processes
10. restart all 8 helyx-channel sessions
11. measure RSS before/after
```

## acceptance_criteria
```gherkin
Feature: MCP servers on shared HTTP transport

  Scenario: playwright shared service
    Given mcp-playwright.service is active
    When 8 helyx-channel sessions connect
    Then ps aux | grep playwright-mcp | wc -l == 1
    And browser_navigate works in all sessions independently
    And browser_snapshot in session B returns empty page when session A is on example.com

  Scenario: context7 shared service
    Given mcp-context7.service is active
    When 8 helyx-channel sessions connect
    Then ps aux | grep context7-mcp | wc -l == 1
    And mcp__context7__query-docs returns results in all sessions

  Scenario: memory target
    Given all MCP HTTP services active
    And 8 sessions active
    Then ps aux grep MCP awk sum < 500 MB
    And free -h used < 10 GB

  Scenario: auto-restart
    Given mcp-playwright is running
    When kill -9 $(pgrep playwright-mcp)
    Then systemctl --user is-active mcp-playwright == active within 10s

  Scenario: session isolation
    Given playwright --isolated
    And session_A.browser_navigate("https://example.com")
    When session_B.browser_snapshot()
    Then session_B.result != "example.com content"
```

## verification_commands
```bash
# process count
ps aux | grep -E "playwright-mcp|context7-mcp|docker-mcp" | grep -v grep | wc -l

# rss total
ps aux | grep -E "playwright-mcp|context7-mcp|docker-mcp|npm exec" | grep -v grep \
  | awk '{sum+=$6} END {printf "%.0f\n", sum/1024}'

# service health
systemctl --user status mcp-playwright mcp-context7

# endpoint check
curl -sf http://localhost:3010/mcp && echo "context7 ok"
curl -sf http://localhost:3011/playwright && echo "playwright ok"

# logs
journalctl --user -u mcp-playwright --since "5 min ago"
journalctl --user -u mcp-context7 --since "5 min ago"
```

## success_metrics
```
metric: mcp_process_count
  before: 90
  after: <10
  measurement: ps aux | grep -E "playwright|context7|docker-mcp" | grep -v grep | wc -l

metric: mcp_rss_mb
  before: 5700
  after: <500
  measurement: ps aux awk sum

metric: total_server_rss_gb
  before: 14.5
  after: <10
  measurement: free -h used field

metric: service_uptime
  target: 99%
  measurement: systemctl --user is-active
```

## risks
```
risk: external_plugins override settings.json → MCP duplicated
  mitigation: research priority order before deploy; remove/disable conflicting plugins

risk: docker-mcp has no HTTP support
  mitigation: keep on stdio for now; track as separate issue

risk: playwright --isolated not available in installed version
  mitigation: verify with npx @playwright/mcp@latest --help | grep isolated

risk: zombie stdio MCP processes after session restart
  mitigation: explicit pkill before restarting sessions

risk: port conflicts
  mitigation: ss -tlnp | grep -E "3010|3011|3012" before deployment
```

## related_files
```
~/.claude/settings.json
~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/playwright/.mcp.json
~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/context7/.mcp.json
~/bots/helyx/scripts/run-cli.sh
~/bots/helyx/docs/issues/mcp-per-session-memory-waste.md
```

# read the session's own transcript instead of scraping its terminal

Status: formalized
Source: user description

## Problem

The live status message tells the operator almost nothing about what the session
is doing, and the reason is not the message — it is what reaches it.

The message itself is already in good shape. `utils/status-render.ts` renders an
expandable blockquote with a 3,400-character budget out of Telegram's 4,096, a
`<pre>` pane, a header and a statistics line. There is room. It arrives empty.

Two pipelines fill it, and both throw away nearly everything:

- `utils/tmux-monitor.ts` polls tmux every **15 seconds** and captures only the
  visible screen, no scrollback (`captureTmux`, `capture-pane -p`). Whatever the
  session drew and scrolled past between two polls is gone. What survives goes
  through `utils/pane-parse.ts:parseLine`, which is a whitelist: `●` tool calls,
  `⎿` sub-lines, the spinner, the agent tree. **Everything else returns `null`** —
  the model's prose, its reasoning, diff bodies, command output.
- `scripts/tmux-watchdog.ts:writePaneSnapshot` polls every 5 seconds, captures 60
  lines, and keeps the **last six** (`PANE_SNAPSHOT_LINES`). It lands in
  `sessions.pane_snapshot` and is discarded by the reader if older than 30s.

So the operator watches a 15-second sample of a whitelist of a screen.

Meanwhile the session already writes a complete, structured record of itself.
Claude Code appends every event of an **interactive** session to
`~/.claude/projects/<slug>/<session-id>.jsonl`: one JSON object per line, with
`timestamp`, `sessionId`, `cwd`, `gitBranch`, `isSidechain`, and a `message`
carrying `thinking`, `text`, `tool_use` and `tool_result` blocks plus full
`usage` token accounting. Verified against a live file during analysis.

## Expected Outcome

The status message is fed from the session's own transcript rather than from a
screen scrape: what the operator reads is what the session actually did, in
order, with nothing silently dropped and nothing lost to a poll interval.

Two constraints shape the whole design:

- **No flag, no restart.** `--output-format stream-json` requires `--print`,
  which is a one-shot non-interactive run — it cannot be added to a session that
  must stay interactive and hold the channel. Nothing about how sessions are
  launched changes, so every running session keeps working across the deploy.
- **No new plumbing.** `docker-compose.yml` already mounts `${HOME}/.claude` at
  `/host-claude-config` and exports `HOST_CLAUDE_CONFIG`; `sessions.project_path`
  already records which directory a session belongs to. Everything needed to find
  the file is in place.

## Out of Scope

- `--session-id` in `run-cli.sh`. It would make the transcript path deterministic
  instead of resolved, but it only takes effect on a session restart — which is
  precisely the cost this flow exists to avoid. Resolution by `cwd` match gives
  the same answer without it.
- Retiring `tmux-monitor.ts` / `output-monitor.ts` / `writePaneSnapshot`. They
  stay as the fallback for a session with no transcript.
- Any change to the rendering in `status-render.ts` beyond how much activity it
  is willing to carry.
- Hook-based event delivery (`PreToolUse`/`PostToolUse`). A second mechanism for
  the same data, and it does need a restart to register.

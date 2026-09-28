# Helyx v1.59.1 Release Notes

**Released:** 2026-09-28

A bugfix release: the response guard no longer mistakes a slow, non-streaming
provider for a hung session, and the installer's seven found gaps are closed.

## What's New

### The response guard no longer punishes a provider for not streaming

MiniMax answers in one block, with no incremental output. tmux sat silent for
the whole turn — 20-30 minutes was observed in production on ARENA and
olimpyx — and the guard's rearm cap (6 cycles, 30 minutes) had no way to tell
that apart from a genuine hang. It fired on ordinary, successful replies,
deleting the status message and requeuing a question that had already been
answered.

`providers.streams` (migration v57, default `true`) lets a provider be flagged
non-streaming. The guard reads it fresh each cycle and widens the cap to 24
cycles (2 hours) instead of turning the check off, so a session that is
actually dead on a non-streaming provider is still caught — just later.
MiniMax's own row is set `streams = false`.

The auth failure underneath this, found in the same investigation: Claude
Code's interactive mode prefers an already-logged-in Claude Max OAuth session
over `ANTHROPIC_API_KEY`, but not over `ANTHROPIC_AUTH_TOKEN` — undocumented,
confirmed by intercepting traffic on both a one-shot and a live interactive
run. Every other third-party provider (GLM, Kimi, DeepSeek, OpenRouter) already
used `bearer`; MiniMax was the first `api_key` case and the first where it
mattered.

A separate, related issue was found but is **not** fixed by this release:
occasionally a session's reply lands in the forum's General topic instead of
its own. That traces to Claude Code's own experimental
`--dangerously-load-development-channels` reconnect handling, triggered when a
provider's reply routinely outlasts Claude Code's own ~600-second request
timeout — outside this codebase, not something helyx's guard cap change
touches.

### Installer: seven found gaps closed

Found by reading `install.sh` and `cli.ts`'s `setup()` end to end:

1. Re-running `install.sh` on an already-configured install always ended in
   `helyx setup` refusing the existing `.env` and exiting 1. Now detects
   `UPDATE_MODE` and skips straight to applying the update.
2. `docker pull` always took `:latest` regardless of the resolved version. Now
   pulls the resolved tag, with a logged fallback to `:latest`.
3. `helyx mcp-register` existed but was never called after a pull — now wired
   into the update path.
4. The systemd step's "no sudo" message no longer implies macOS needs sudo it
   doesn't.
5. Version resolution used to fall back to `v1.0.0` silently if the GitHub API
   was unreachable. Now fails loudly and says why.
6. `helyx.service`'s static template hardcoded `/home/%i/bots/helyx`, so a
   custom install directory got a unit pointing at the wrong path. Now
   template-substituted with the real install directory.
7. `restart` (container only) and `bounce` (sessions only) had no combined
   form on the CLI — only as the Telegram `full_restart` admin command. Added
   `helyx full-restart`, reusing `bounce`'s lease-handling.

## Upgrade

Migration v57 (`providers.streams`) runs automatically inside the bot
container on next deploy — no manual step. To mark a provider as
non-streaming yourself:

```sql
UPDATE providers SET streams = false WHERE name = '<provider name>';
```

Sessions on an affected project pick up the wider guard cap on their next
restart (`proj_start` / `bounce` / a full restart) — the running process holds
the code it started with, same as any other `channel/**` change.

## PRs

[#121](https://github.com/MrCipherSmith/helyx/pull/121) —
response guard streaming fix.
[#114](https://github.com/MrCipherSmith/helyx/pull/114) —
installer hardening.

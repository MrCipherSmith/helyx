# Helyx v1.49.0 Release Notes

**Released:** 2026-05-03

## What's New

### Supervisor Overhaul

Five improvements to the session supervisor (`scripts/supervisor.ts`).

**Smart status broadcast**
The 5-minute status message now edits itself in-place (silent) when everything is healthy. It only deletes and re-sends (triggering a Telegram notification) when a problem is detected — stuck queue or a Docker container showing 🔴.

**Stuck queue auto-recovery**
`checkStuckQueue` previously only sent an alert with manual buttons. It now triggers `proj_start` automatically before alerting — same recovery flow as hung sessions. The alert with manual buttons appears only if auto-recovery fails.

**`/supervisor` command**
On-demand system status is now available as a `/supervisor` bot command, accessible from any chat or topic — not just by texting in the dedicated supervisor topic.

**Acknowledge button**
All supervisor alerts now include a "🔕 Тишина 30м" button. Clicking it writes an ack record to `admin_commands`. The supervisor reads active acks from DB at the start of each loop iteration and skips alerting during the silence window. This eliminates alert fatigue during planned maintenance or known issues.

**Better escalation**
When a session fails to recover for 30+ minutes, the escalation path now:
1. Kills hung channel processes (`pkill -f "bun.*channel.ts"`) to free resources
2. Triggers `proj_start` fresh
3. On failure, shows a "🚀 Bounce бот" button that queues a `bounce` admin command

## Upgrade

No database migrations. No new environment variables. Drop-in upgrade — restart the bot container after pulling.

#!/bin/bash
# Claude Code PreToolUse hook for AskUserQuestion — carry the question to
# Telegram and bring the answer back.
#
# Registered in ~/.claude/settings.json hooks.PreToolUse by the helyx setup
# wizard, with matcher "AskUserQuestion".
#
# The tool draws its own selector in the terminal and is not a permission
# request, so none of the machinery that carries permission prompts to Telegram
# ever saw it. A session once sat blocked for 21 minutes on a question the
# operator could not see.
#
# Receives the hook payload on stdin. Prints either nothing — and the selector
# is drawn as always — or a PreToolUse decision carrying the operator's answer.
#
# Every failure path here is silence. A hook that cannot reach the bot, or times
# out, must leave the terminal exactly as it was: this feature can add a way to
# answer, but it must never take one away.

set -uo pipefail

INPUT=$(cat)
PORT="${PORT:-3847}"

# --max-time is a little under the hook's own 600s budget, so the curl gives up
# first and this script still exits cleanly.
RESPONSE=$(printf '%s' "$INPUT" | curl -sf -X POST "http://localhost:${PORT}/api/hooks/ask-question" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  --max-time 590 2>/dev/null) || exit 0

# 204 — nothing to say. The bot could not place the question, or nobody
# answered in time.
[ -z "$RESPONSE" ] && exit 0

printf '%s' "$RESPONSE"
exit 0

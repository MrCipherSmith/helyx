#!/bin/bash
# Claude Code PreCompact hook — summarize before the context folds.
# Registered in ~/.claude/settings.json hooks.PreCompact by the helyx setup wizard.
#
# Receives JSON on stdin: { "session_id": "...", "transcript_path": "...", ... }
#
# This is the safety net, not the primary path. The supervisor's context loop
# summarizes at a threshold while the session is idle; this catches the case it
# cannot — a window that fills in one step, a large file read or a long test
# log, where the last measurement was well under the threshold and the fold is
# now.
#
# It never blocks. PreCompact can refuse compaction (exit 2, or a `block`
# decision), and using that to buy time turns a slow summariser into a session
# that cannot continue. Every path here exits 0: no transcript, no bot, a
# refused request, a timeout. The worst outcome is the situation before this
# hook existed — the fold happens without a Helyx summary — which is not a
# regression.

set -uo pipefail

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || true)
TRIGGER=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('trigger','auto'))" 2>/dev/null || true)
PORT="${PORT:-3847}"

[ -z "$TRANSCRIPT_PATH" ] && exit 0
[ ! -f "$TRANSCRIPT_PATH" ] && exit 0

# --max-time is the whole point: the fold waits for this call, so the call has
# to end. Twenty seconds is enough for the summariser on an ordinary session and
# short enough that a stuck one is not felt as a hang.
curl -sf -X POST "http://localhost:${PORT}/api/hooks/pre-compact" \
  -H "Content-Type: application/json" \
  --data-raw "{\"transcript_path\": \"${TRANSCRIPT_PATH//\"/\\\"}\", \"project_path\": \"${PWD//\"/\\\"}\", \"trigger\": \"${TRIGGER//\"/\\\"}\"}" \
  --max-time 20 \
  > /dev/null 2>&1 || true

exit 0

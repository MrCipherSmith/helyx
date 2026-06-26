#!/bin/bash
# Auto-restart wrapper for Claude Code CLI sessions.
# Usage: scripts/run-cli.sh /path/to/project
#
# Runs claude with channel adapter in a loop, restarting on crash.
# Clean exit (code 0) stops the loop.
#
# When running outside tmux, captures terminal output via `script`
# to /tmp/claude-output-<project>.log for progress monitoring.

PROJECT_DIR="${1:-.}"
RESTART_DELAY="${RESTART_DELAY:-5}"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
LOG_FILE="/tmp/cli-${PROJECT_NAME}.log"
OUTPUT_FILE="/tmp/claude-output-${PROJECT_NAME}.log"

cd "$PROJECT_DIR" || { echo "[run-cli] Cannot cd to $PROJECT_DIR"; exit 1; }

echo "[run-cli] Project: $PROJECT_DIR"
echo "[run-cli] Log: $LOG_FILE"

# Load shared API keys from helyx .env (GROQ_API_KEY, OPENAI_API_KEY, etc.)
# then overlay project-specific .env on top. Skip already-set vars to avoid
# overriding Docker-injected values like DATABASE_URL.
load_env() {
  local envfile="$1"
  [ -f "$envfile" ] || return
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue  # skip comments
    [[ -z "${line// }" ]] && continue             # skip blank lines
    key="${line%%=*}"
    [[ -z "${!key}" ]] && export "$line" 2>/dev/null  # only if not already set
  done < "$envfile"
}

HELYX_DIR="$(dirname "$(dirname "$(realpath "$0")")")"
load_env "$HELYX_DIR/.env" && echo "[run-cli] Loaded helyx .env"
if [ "$PROJECT_DIR" != "$HELYX_DIR" ] && [ -f ".env" ]; then
  load_env ".env" && echo "[run-cli] Loaded project .env"
fi

MAX_RESTARTS_IN_WINDOW="${MAX_RESTARTS_IN_WINDOW:-3}"
RESTART_WINDOW_SECONDS="${RESTART_WINDOW_SECONDS:-300}"
PROJECT_NAME="$(basename "${PROJECT_DIR:-$(pwd)}")"
STATE_FILE="/tmp/helyx-restart-${PROJECT_NAME}.state"

# Detect if we're inside tmux
IN_TMUX="${TMUX:-}"

if [ -z "$IN_TMUX" ]; then
  echo "[run-cli] Not in tmux — capturing output to $OUTPUT_FILE"
fi

while true; do
  # --- Restart rate limiter ---
  _now=$(date +%s)
  if [ -f "$STATE_FILE" ]; then
    _win_start=$(sed -n '1p' "$STATE_FILE")
    _count=$(sed -n '2p' "$STATE_FILE")
    _win_start="${_win_start:-0}"
    _count="${_count:-0}"
    if [ $(( _now - _win_start )) -gt "$RESTART_WINDOW_SECONDS" ]; then
      # Window expired — reset
      printf '%s\n%s\n' "$_now" "1" > "$STATE_FILE"
    elif [ "$_count" -ge "$MAX_RESTARTS_IN_WINDOW" ]; then
      # Escalate and stop
      echo "[run-cli] ESCALATION: restarted ${_count} times in ${RESTART_WINDOW_SECONDS}s — stopping" >&2
      mkdir -p "${PROJECT_DIR}/logs/restart-failures"
      _marker="${PROJECT_DIR}/logs/restart-failures/${PROJECT_NAME}-$(date +%s).failed"
      if [ -n "${TMUX_PANE:-}" ]; then
        tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null | tail -50 > "$_marker" || true
      else
        tail -50 "${LOG_FILE:-/dev/null}" > "$_marker" 2>/dev/null || true
      fi
      if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${SUPERVISOR_CHAT_ID:-}" ]; then
        _project_db_id=$(psql "${DATABASE_URL:-}" -t -c "SELECT id FROM projects WHERE path='${PROJECT_DIR}'" 2>/dev/null | tr -d ' \n' || true)
        _tg_body="{\"chat_id\":\"${SUPERVISOR_CHAT_ID}\",\"text\":\"🚨 ${PROJECT_NAME}: Claude Code перезапустился ${_count} раз за ${RESTART_WINDOW_SECONDS}сек — остановлен.\\nТребуется ручной запуск.\""
        if [ -n "${SUPERVISOR_TOPIC_ID:-}" ]; then
          _tg_body="${_tg_body},\"message_thread_id\":${SUPERVISOR_TOPIC_ID}"
        fi
        if [ -n "${_project_db_id:-}" ]; then
          _tg_body="${_tg_body},\"reply_markup\":{\"inline_keyboard\":[[{\"text\":\"🔄 Запустить вручную\",\"callback_data\":\"sup:start_by_pid:${_project_db_id}\"}]]}"
        fi
        _tg_body="${_tg_body}}"
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
          -H "Content-Type: application/json" \
          -d "$_tg_body" > /dev/null || echo "[run-cli] Telegram escalation failed" >&2
      fi
      exit 0
    else
      printf '%s\n%s\n' "$_win_start" "$(( _count + 1 ))" > "$STATE_FILE"
    fi
  else
    printf '%s\n%s\n' "$_now" "1" > "$STATE_FILE"
  fi
  # --- End restart rate limiter ---

  echo "[run-cli] Starting claude at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  CHANNEL_LOG_FILE="/tmp/channel-${PROJECT_NAME}.log"
  export CHANNEL_LOG_FILE

  if [ -z "$IN_TMUX" ]; then
    # Outside tmux: capture terminal output via script for monitoring
    > "$OUTPUT_FILE"  # truncate
    script -qfc "CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:helyx-channel" "$OUTPUT_FILE"
    EXIT_CODE=$?
  else
    # Inside tmux: watch for the "development channels" warning prompt and auto-confirm.
    # Checks immediately, then every 0.5s for up to 60s (120 iterations).
    # Stops as soon as the prompt is confirmed or Claude moves past it.
    PANE="${TMUX_PANE}"
    (
      for i in $(seq 1 120); do
        out=$(tmux capture-pane -t "$PANE" -p 2>/dev/null)
        if echo "$out" | grep -q "Enter to confirm"; then
          tmux send-keys -t "$PANE" "" Enter
          break
        fi
        # Already past the prompt (running or exited) — stop watching
        if echo "$out" | grep -q "Listening for channel\|run-cli\] Exited"; then
          break
        fi
        sleep 0.5
      done
    ) &
    CONFIRM_PID=$!
    CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:helyx-channel
    EXIT_CODE=$?
    # Clean up the confirm watcher if Claude exited before it finished
    kill "$CONFIRM_PID" 2>/dev/null
  fi

  echo "[run-cli] Exited with code $EXIT_CODE at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

  # Clean exit — don't restart
  if [ $EXIT_CODE -eq 0 ]; then
    rm -f "$STATE_FILE"
    echo "[run-cli] Clean exit, stopping."
    break
  fi

  echo "[run-cli] Restarting in ${RESTART_DELAY}s..." | tee -a "$LOG_FILE"
  sleep "$RESTART_DELAY"
done

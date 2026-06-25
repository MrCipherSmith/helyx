# PRD: Gemma Health Analyst

## Problem

The current supervisor is reactive: it detects specific failures via hardcoded rules, then optionally calls Gemma/Qwen to *explain* what happened. There is no holistic, proactive health review of the whole system — no single loop that looks at everything together and makes a judgment call on overall state.

## Goal

Add a **Loop 6** to `supervisor.ts`: a proactive health analyst powered by local Gemma (via Ollama) that periodically reads the full system snapshot and either stays silent (healthy) or sends a human-readable digest to the supervisor Telegram channel.

This loop is an **observer only** — it never takes recovery actions (unlike Loops 1–2). Its job is to summarize what the existing loops might miss and give the operator a narrative health report.

---

## Scope

### In scope
- New monitoring loop in `scripts/supervisor.ts`
- State collection from DB + shell (sessions, queue, tmux, docker, process_health)
- Gemma prompt + response parsing
- Silent when healthy, digest to supervisor channel when not
- Dedup: one message per 10-min window per problem key

### Out of scope
- Automated recovery actions
- A separate standalone service/script (loop lives in supervisor)
- Any UI or dashboard changes

---

## State snapshot collected each cycle

| Source | What is collected |
|--------|-------------------|
| `sessions` table | Active count, project names, oldest `last_active` |
| `active_status_messages` | Any with `updated_at` stale > 5 min (spinner stuck) |
| `message_queue` | Pending messages waiting > 2 min |
| `process_health` | Status of all watchdog processes |
| `tmux ls` (shell) | Which tmux sessions are alive |
| `docker ps` (shell) | Container names + status |

---

## Gemma prompt contract

The snapshot is serialized as structured text and sent to Gemma with:

**System prompt:** "Ты — аналитик здоровья системы Helyx. Прочитай снапшот состояния. Если всё в норме — ответь только словом OK. Если есть проблемы — кратко опиши их в 2–5 пунктах на русском. Не рассуждай, только факты."

**User message:** formatted state snapshot (< 800 tokens)

**Response rules:**
- Starts with `OK` → nothing sent to Telegram
- Otherwise → text is sent as digest to supervisor channel

---

## Model config

- Primary: `SUMMARIZE_MODEL` env var (currently `gemma4:e4b`)
- Fallback: `OLLAMA_CHAT_MODEL` (`qwen3:8b`)
- Timeout: 15 seconds
- If Ollama unreachable: skip silently, log a single line

---

## Behavior spec

| Condition | Action |
|-----------|--------|
| Gemma says OK | Nothing sent, loop continues |
| Gemma reports issues | Send digest to `SUPERVISOR_CHAT_ID / SUPERVISOR_TOPIC_ID` |
| Gemma unavailable | Skip silently (non-blocking) |
| Same issue repeated next cycle | Dedup — no second message within 10 min |
| `SUPERVISOR_CHAT_ID` not set | Log digest to console only |

**Loop interval:** every 10 minutes  
**Loop name in logs:** `gemma-health`

---

## Acceptance criteria

- [ ] Loop runs every 10 min without blocking other supervisor loops
- [ ] Collects all 6 state sources listed above
- [ ] Gemma prompt fits in < 800 tokens (snapshot is truncated if needed)
- [ ] `OK` response → no Telegram message sent
- [ ] Non-OK response → message appears in supervisor channel with timestamp
- [ ] Dedup: same problem key not re-alerted within 10-min window
- [ ] Gemma timeout or connection error → loop logs warning, does not crash supervisor
- [ ] Loop respects existing `SUPERVISOR_CHAT_ID` / `SUPERVISOR_TOPIC_ID` config
- [ ] No interference with Loops 1–5 (no shared mutable state)
- [ ] `process_health` row updated: name = `gemma-health`, status = `ok` / `degraded`

---

## Non-goals

- This loop does **not** restart sessions, clear queues, or take any action
- It does **not** replace existing rule-based loops (they remain unchanged)
- It does **not** run as a separate process — it is a loop inside supervisor

---

## Decisions

1. **Healthy state** → silent. No periodic "all good" messages.
2. **Interval** → 10 minutes.
3. **Docker state** → collected via MCP docker tools (`docker_container_list`), not shell exec.

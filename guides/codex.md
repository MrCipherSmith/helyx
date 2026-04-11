# AI Code Review with Codex

Helyx integrates **OpenAI Codex CLI** as a dedicated code review agent. When you ask for a review — via Telegram command or just in conversation — the bot routes the request to Codex, which reads your git diff and produces a structured analysis.

---

## How it works

```
You:    "сделай ревью"  (or /codex_review)
                ↓
Helyx:  checks Codex auth
                ↓
Codex:  reads git diff → analyzes → returns report
                ↓
Helyx:  sends report to your Telegram topic
```

If Codex is unavailable (quota exhausted, not logged in), Helyx falls back silently to Claude's native 4-agent code review — you get a review either way.

---

## Setup

### Step 1 — Authenticate

Send `/codex_setup` in Telegram. The bot will:

1. Run `codex login --device-auth`
2. Send you a link + one-time code:

```
Codex Login

1. Open the link below in your browser
2. Enter this code: BWW4-XKUNM

[Open in browser]
```

3. Open the link, sign in with your ChatGPT account, enter the code
4. Bot polls for completion — notifies you when done

> Works entirely from Telegram on any device. No terminal needed.

### Step 2 — Use it

```
/codex_review                          — review latest branch changes
/codex_review focus on security only   — with custom prompt
/codex_status                          — check login status
```

Or just ask naturally in your project topic:
```
"сделай ревью"
"check my changes"
"review PR"
```
Claude will automatically invoke Codex for these requests.

---

## Model

Default model: **`gpt-4.5-mini`** (configurable via `CODEX_MODEL` in `.env`).

```env
CODEX_MODEL=gpt-4.5-mini   # default
CODEX_MODEL=o3             # stronger reasoning
CODEX_MODEL=o4             # full o4
```

---

## Fallback behavior

| Situation | What happens |
|-----------|-------------|
| Codex authenticated | Review runs via Codex |
| Not logged in (via `/codex_review`) | Bot tells you to run `/codex_setup` |
| Quota exceeded / error | Silent fallback to Claude's native review |
| Not logged in (via natural language) | Claude runs native review |

The fallback is silent — you get a review regardless. Only `/codex_review` command explicitly checks auth and stops early.

---

## Commands

| Command | Description |
|---------|-------------|
| `/codex_setup` | Authenticate Codex via device flow (headless, no terminal) |
| `/codex_review [prompt]` | Run a Codex code review, optional custom prompt |
| `/codex_status` | Check current login status |

---

## Notes

- Codex reads the git repository automatically — no need to specify files or diffs
- Session persists after authentication; re-run `/codex_setup` only if you log out
- The `CODEX_MODEL` env var takes any OpenAI model name supported by the Codex CLI

# What runs, where, and what to call it

Written 2026-08-08, from the running system rather than from intent. Every name
below is either what the code already calls the thing, or a name chosen here
because the code had none and the operator needed one.

The point of this document is that "restart it" is not a single instruction.
There are four groups, they fail differently, and three of the four have been
mistaken for each other at least once.

---

## The four groups

| Group | Where it lives | What restarts it | What its silence means |
|---|---|---|---|
| **Containers** | Docker | `docker compose up -d bot` | the bot is down; Telegram gets nothing |
| **The host daemon** | one `bun` process on the host | `full_restart`, or restart `admin-daemon.ts` | nothing watches anything; no alarms, no summaries |
| **Sessions** | one tmux window + one `channel.ts` per project | `bun cli.ts bounce` | sessions run yesterday's code, and say nothing about it |
| **The host proxy** | one optional `bun` process | `helyx up` (starts only) | nothing, unless a session is pointed at it |

The rule that follows: **code that ships in the container does not reach a
running session.** The container and the sessions are restarted by different
commands, and a change to `channel/**` or anything it imports is not live until
the sessions are bounced. The symptom of getting this wrong is silence, not an
error.

---

## Group 1 — Containers

Two, from `docker-compose.yml`.

**`helyx-bot-1`** — runs `main.ts`. This is the Telegram bot: the command
handlers, the callback routes, the MCP HTTP server on port 3847 that every
Claude Code session connects to, the startup recovery of stale status messages
and undelivered replies, and the cleanup timer.

**`helyx-postgres-1`** — the database. Sessions, projects, providers, the
message queue, long-term memory and its embeddings, permissions, incidents.

---

## Group 2 — The host daemon, and the watchers inside it

One process — `scripts/admin-daemon.ts` — started on the host by `cli.ts`. It is
not one thing. Four watchers live inside it, and they are the part people mean
when they say "the supervisor".

**`admin-daemon`** — the host's hands. It is what can touch tmux, the working
copy and Docker, because it is outside the container. It also owns the restart
lease, so two restarts cannot race.

**`supervisor`** (`scripts/supervisor.ts`) — thirteen loops on their own
intervals, all inside the daemon above. Named individually because "the
supervisor said something" is otherwise unanswerable:

| Loop | Every | What it watches |
|---|---|---|
| session heartbeat | 60 s | a session that has stopped answering |
| stuck queue | 60 s | a message nobody delivered |
| recovery check | 60 s | a session that can be brought back |
| context pressure | 2 min | a context window filling up, and the pulse |
| unanswered messages | 2 min | a question the operator never got an answer to |
| bot alive | 20 s | the container serving, or not |
| error stream | 90 s | what the bot itself logged |
| voice cleanup | 5 min | stale voice status messages |
| status broadcast | 5 min | the periodic system picture |
| health analyst | 10 min | a whole-system look, through a local model |
| scheduled review | 15 min | a branch that stopped changing |
| idle auto-compact | 30 min | a session idle long enough to summarise |
| reviewer health | 30 min | whether the reviewers can review |

**`tmux-watchdog`** (`scripts/tmux-watchdog.ts`) — polls every tmux window and
writes a pane snapshot to the session row. Note for anyone reaching for it as an
activity signal: it stamps `pane_snapshot_at` on every poll of every live
window, so that column is the watcher's heartbeat and not the session's.
`sessions.last_active` is the same trap, written unconditionally by the channel's
lease renewal.

**`tmux-session-logger`** (`scripts/tmux-session-logger.ts`) — records what
scrolls past in a pane.

**`host-ingress`** (`scripts/host-ingress.ts`) — the way back in when everything
else is down. It polls Telegram directly whenever the bot is confirmed dead, so
`/up` and `/hstatus` work while the container cannot answer.

---

## Group 3 — Sessions

One per project. Each is a tmux window running Claude Code, plus one
`channel.ts` subprocess started by the CLI on the host and living as long as
that session.

**`channel`** (`channel.ts` and everything it imports) — the session's own half
of the system, and the half people forget. It tails the transcript, renders the
status message, delivers queued messages into the pane, captures what a context
fold dropped, and notices when the session has hit an API limit. It holds a
lease on its session row so two channels cannot own one session.

The eight `channel.ts` processes on the host are eight sessions. They are
bounced together by `bun cli.ts bounce`, which kills the tmux session and starts
its windows again.

---

## Group 4 — The host proxy

**`ollama-proxy`** (`scripts/ollama-proxy.ts`) — an Anthropic-compatible
endpoint in front of a local model, so Claude Code can be pointed at one. Off by
default behind `OLLAMA_PROXY_ENABLED`, and host-side rather than containerised
because the model is. Known: the flag gates *starting* it, not running it —
nothing stops one that is already up, and a bounce will not replace it with new
code.

---

## Naming, so the words stop colliding

- **container** — one of the two Docker services. Not "the bot" on its own: the
  bot is what runs inside `helyx-bot-1`.
- **daemon** — `admin-daemon`, the single host process. Say "daemon" when the
  question is whether it is alive, and name the loop when the question is what
  it did.
- **watcher** — one of the four things inside the daemon (`supervisor`,
  `tmux-watchdog`, `tmux-session-logger`, `host-ingress`). They are not
  processes; killing one means restarting the daemon.
- **loop** — one of the supervisor's thirteen. Always by its name from the table
  above.
- **session** — the tmux window *and* its channel, together. They start and die
  together, and treating them separately is how "I restarted it" and "it is
  still on the old code" end up both being true.
- **channel** — the host subprocess belonging to one session. Say "channel" when
  the point is that the container's code did not reach it.
- **proxy** — `ollama-proxy`, and nothing else.

## Restart vocabulary

| Say this | And it means |
|---|---|
| **stack up** | bring up whatever is down, break nothing that works |
| **container restart** | `docker compose up -d --build bot` — new code for the bot only |
| **bounce** | restart the sessions and their channels — new code for the session half |
| **full restart** | both, in that order: rebuild the container, then bounce |
| **channel kill** | drop the channel subprocesses without touching tmux |

`bounce`, `host_restart` and `full_restart` triggered from Telegram take a file
lease first, so a second restart is refused rather than raced. `bun cli.ts
bounce` run by hand on the host does **not** take that lease — it is the one
path that still needs a human to check nothing else is restarting.

# EN · Technical

**Tone:** for engineers. Says what it is and how it is built, without selling.
**Suggested image:** `assets/en/01-architecture.png`, then `assets/en/04-numbers.png`.
**Length:** ~230 words.

---

Helyx v1.55.2 is out.

Helyx lets me run Claude Code on all of my projects from Telegram. It is not a
chat wrapper. Every project has a real coding session that keeps running on my
own machine after I close the app.

The design is simple. One Telegram forum topic per project. Messages go into a
Postgres queue; a small stdio MCP process attached to each session polls that
queue, hands the message to the session, and sends the answer back. The session
lives in its own tmux window, so a bot restart does not touch it — the two
halves are separate on purpose, and each one can be restarted without the
other.

What that structure gives you:

• Sessions persist. Close Telegram, come back an hour later, the context is
  still there.
• Memory outlives the session. Decisions and constraints are stored in pgvector
  and returned by meaning, so the next session already knows them.
• A live status message shows what the agent is doing right now — files read,
  tests run, subagents working — and tool calls can be approved or denied from
  the phone.
• Voice works in both directions: Whisper in, and a short spoken recap back,
  synthesized locally by Piper.

Bun, Postgres with pgvector, MCP over stdio and HTTP, 1902 unit tests. Fully
self-hosted — my keys, my machine.

github.com/MrCipherSmith/helyx

#ClaudeCode #MCP #DeveloperTools #OpenSource #AIAgents

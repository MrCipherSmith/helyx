# Interactive Polls

When Claude Code needs clarification before continuing a task, it can ask questions as native **Telegram polls** instead of plain text messages. You tap your answer, hit **Submit ✅**, and the results flow back automatically.

## How it works

1. Claude decides it needs user input (ambiguous requirement, preference choice, etc.)
2. It calls the `send_poll` MCP tool with a list of questions and options
3. Each question arrives as a non-anonymous Telegram poll in your project topic
4. You vote on each poll
5. You press the **Submit ✅** button
6. Your answers are formatted as readable text and queued back to Claude as a user message
7. Claude continues with the context it asked for

```
Claude:  "Before I scaffold this, a few questions:"
         [poll] Which framework?  ○ Next.js  ○ Remix  ○ Astro
         [poll] TypeScript?       ○ Yes      ○ No

You:     tap Next.js, tap Yes, tap Submit ✅

Claude:  "Got it — scaffolding Next.js + TypeScript..."
```

## Tool signature

Claude calls `send_poll` with:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Short description shown before the polls |
| `questions` | array | List of `{ question, options[] }` |

Each question becomes one poll. All questions must be answered before **Submit ✅** is accepted — if you tap it early, the bot shows how many are left.

## Forum routing

In forum mode, polls land in the correct project topic automatically — the same topic where your conversation is happening.

## Expiry

Poll sessions expire after **24 hours**. Clicking **Submit ✅** on an expired session shows a timeout message and marks the session as expired.

## Retraction

If you change your mind on a poll, tap a different option — Telegram sends a new vote event and the answer is updated. If you retract a vote entirely (Telegram allows this for non-anonymous polls), that question is treated as unanswered.

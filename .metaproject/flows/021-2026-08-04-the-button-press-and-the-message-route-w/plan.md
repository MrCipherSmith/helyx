# Plan

## 1. The routing table

`handleCallbackQuery` fuses two things: deciding which handler a callback
belongs to, and calling it. Split them.

- `utils/callback-route.ts`: `routeCallback(data)` → a handler key, from an
  ordered table. Pure, exhaustively testable, and the shadowing becomes a
  property of the data rather than of statement order.
- `handleCallbackQuery` switches on the key. The dynamic imports stay where
  they are — they are the reason the file loads fast.

The test that matters: every prefix reaches its own key, and `skill:save:x`
reaches approval rather than the tool launcher.

## 2. The router

`routeMessage(chatId, forumTopicId, deps)` — the same injection shape used by
`deliverTurnSummary` and the ask-question service. Tested for:

- forum topic → project, active session → cli
- forum topic → project, dead session → disconnected, keeping the project path
- **unmapped topic → disconnected, not DM routing** (the cross-project leak)
- General topic (id 1) and no topic → DM routing
- DM with no session → standalone
- DM whose session vanished → standalone, and the chat is switched back

The reimplementation in `forum-topics.test.ts` goes: a copy that agrees by
coincidence is worse than no test, because it reads like one.

## 3. The toast

`handleQuestionCallback` maps four outcomes to four things the operator sees.
Driven with a fake context, asserting the text for each — including that a
completed set says "отправляю" and a lost race says the question is gone.

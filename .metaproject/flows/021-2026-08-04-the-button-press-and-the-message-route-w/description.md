# The button press and the message route, which nothing watches

Status: ready
Source: operator choice, 2026-08-04 — "кнопки и маршрутизация"

## Problem

Two paths carry every interaction the operator has with this bot, and neither
is watched. `bot/callbacks.ts` is at 3.9% line coverage and `sessions/router.ts`
at 3.0%.

**The callback dispatch is twenty sequential prefix tests.** Order is
load-bearing and invisible: `skill:save:` must be matched before `skill:`,
because `skill:` would swallow it and hand a save to the tool launcher. A
button that silently does the wrong thing is worse than one that errors, and
nothing here would notice a reordering — the file has no test that reaches the
dispatch at all.

This matters more now than last week. The operator asked for questions with
buttons and now works through them; every answer is a callback.

**The router decides which session receives a message.** Its most consequential
branch is the one that must *not* fall through: a forum topic with no project
mapped returns disconnected rather than dropping to DM routing, because
dropping through would deliver the message to some other project's session.
That is a cross-project leak guarded by a comment.

The existing `tests/unit/forum-topics.test.ts` covers this by *reimplementing*
it — a private copy of the routing rules that agrees with the original by
coincidence. It cannot catch a change to the code it claims to describe.

## Expected Outcome

- The callback routing table is data, and every prefix — including the three
  shadowed ones — is asserted to reach its own handler.
- `routeMessage` is tested against the real function: forum, DM, standalone,
  disconnected, and the unmapped topic that must not fall through.
- The answer toast the operator sees matches what actually happened to their
  press.

## Out of Scope

- Rewriting any handler. This is about which one is reached, not what it does.
- The handlers behind the prefixes; each is its own file and its own flow.

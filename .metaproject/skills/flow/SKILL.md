---
name: flow
description: Use whenever the user asks to start, create, track, or finish a managed piece of work - "создай фло", "заведи флоу из этой ишью", "create a flow", "start a story", "какой статус по фло", "заверши фло/стори", or pastes an issue link asking to work on it. All flow state changes go through the gd-metapro flow CLI; never edit flow.json or frozen acceptance criteria by hand.
---

# flow Skill (router)

A flow is a story from initialization to completion. The user does NOT need to
know CLI commands - recognize the intent and route it yourself.

## Trigger Examples -> Intent

| User says (RU/EN) | Intent | Do |
|---|---|---|
| "Создай фло: <описание проблемы>" / "create a flow for ..." | init from description | `gd-metapro flow init --title "<формализованный заголовок>"`, then follow [init.md](init.md) |
| "Создай фло на основании <issue URL>" / "make a flow from this issue" / вставил issue-ссылку + "сделай" | init from issue | `gd-metapro flow init --issue <url>`, then [init.md](init.md) |
| "Заведи стори / инициализируй задачу / start a story" | init | ask for a problem description or issue link if missing, then init |
| "Какие фло активны? / статус по фло / where are we on 003" | status | `gd-metapro flow list` / `flow status <id>` |
| "Отметь задачу T2 / добавь задачу в фло" | manage | [manage.md](manage.md): `flow task done/add` |
| "Имплементация готова, PR создан" | accept implementation | [manage.md](manage.md): verify draft PR, `flow implemented --pr <url>` |
| "Заверши фло / закрой стори / finish the flow" | complete | [complete.md](complete.md): confirm ACs, `flow complete` |
| "Фло застрял / поставь на паузу" | block | `flow block <id> --reason` / `flow unblock` |

Ambiguous ("сделай эту фичу" without flow context): if the work is
non-trivial and multi-step, propose starting a flow; for one-liners just do
the work.

## Roles

- Starting new work: [init.md](init.md) - flow-init.
- Orchestrating/implementing an active flow: [manage.md](manage.md) -
  flow-manager (embeds into the orchestrator).
- Finishing a flow whose draft PR exists: [complete.md](complete.md) -
  flow-complete.

## Hard policy (all roles)

- flow.json is CLI-owned. Never edit it by hand.
- Acceptance criteria are frozen after `flow freeze`; edits only via
  `gd-metapro flow ac update <id> --reason`. Implementors NEVER touch them.
- Status changes only through the CLI; invalid transitions are rejected.
- Only flow-manager declares implementation complete (`flow implemented`),
  and only when a draft PR exists.

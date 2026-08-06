# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The status header carries the age of the last event when one is known — `⧗ 3s` under a minute, `⧗ 4m` above — and carries nothing extra when it is not known, so a status with no monitor renders exactly as it did before.
- AC2: The idle age is rounded before it is rendered (whole seconds under a minute, whole minutes above), so the edit-suppressing signature is not defeated by a number that changes every tick.
- AC3: When subagents are running, one line above the activity block names them and says how many — and it is absent, not empty, when none are.
- AC4: The agents line and the summary line sit above the activity quote, so `tailWithinBudget` trimming a busy turn cannot drop them.
- AC5: `summarizeActivity` returns the last line of activity that is a tool call, stripped of its bullet and any `[label]` prefix and capped; it returns null when there is nothing that qualifies, and the status then renders without a summary line.
- AC6: `TranscriptSession` exposes the labels of the subagents it is currently following, and the monitor handle exposes them without changing the status callback's signature; an agent that finishes leaves the list.
- AC7: Every existing budget still holds: `WORK_BUDGET_CHARS` bounds the work section, `HEADER_BUDGET_CHARS` the header, and a status that was inside the Telegram limit before is inside it after.
- AC8: `bun test tests/unit/` passes, and new tests cover the header's idle age, the agents line, the summary derivation and the label getter.

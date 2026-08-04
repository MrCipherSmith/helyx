# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every callback prefix the bot answers routes to its own handler key, asserted one prefix at a time.
- AC2: skill:save:, skill:reject: and skill:editname: route to approval and not to the tool launcher, and the test fails if the table is reordered.
- AC3: An unrecognised callback routes to nothing and the operator is told, rather than being silently ignored.
- AC4: routeMessage is tested through the real exported function, not a copy of its rules.
- AC5: A forum topic with an active session routes to cli, carrying the project path.
- AC6: A forum topic whose session is gone routes to disconnected and still carries the project path and name.
- AC7: A forum topic with no project mapped routes to disconnected and does NOT fall through to DM routing.
- AC8: Topic id 1 and an absent topic both take DM routing.
- AC9: A chat with no session is standalone; a chat whose session vanished is standalone and is switched back to it.
- AC10: Each of the four question-callback outcomes produces its own toast text.
- AC11: The reimplementation of routing rules in forum-topics.test.ts is gone, replaced by tests of the real function.
- AC12: Every new test was checked by reintroducing the bug it covers, and each one failed.
- AC13: Full gate green: bun test, typecheck, eslint 0 errors, dupes unchanged.

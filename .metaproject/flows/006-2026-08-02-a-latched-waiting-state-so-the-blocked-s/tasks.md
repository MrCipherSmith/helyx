# Tasks

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Establish the exit paths of pollForResponse and where the phase is computed |
| T2 | implement | `resolvePhase`, the counted latch in StatusManager, and the try/finally scope |
| T3 | test | Cover resolvePhase and the counting behaviour |
| T4 | review | Verify, draft PR, Codex review |

## Notes

- T2's latch counts holders rather than flagging, so two overlapping requests
  in one chat cannot clear each other.
- T4 must state the verification limit rather than imply an end-to-end test.

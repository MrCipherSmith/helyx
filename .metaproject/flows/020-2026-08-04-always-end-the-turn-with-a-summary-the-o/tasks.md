# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Read the stop hook, the guard and the pane parser end to end |
| T2 | implement | utils/turn-summary.ts — the pure decision and formatting |
| T3 | implement | Deliver the summary to the project topic from /api/hooks/stop |
| T4 | implement | The guard stays quiet while a question is open |
| T5 | implement | The interactive prompt stops leaking into the status pane |
| T6 | test | Tests for each, every one checked by reintroducing the bug |
| T7 | review | Full gate, draft PR, Codex review |

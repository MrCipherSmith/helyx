# Tasks

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Establish that the red state is unreachable and which states are lost |
| T2 | implement | Write `utils/supervisor-status.ts` and rewire `sendStatusBroadcast` |
| T3 | test | Cover all four decisions, with real `docker ps` strings as fixtures |
| T4 | review | Verify (typecheck, lint, tests, health, live docker check), draft PR, Codex review |

## Notes

- T1 is complete: findings in `context.md`.
- T2 inverts the container check from blacklist to allowlist. That is the
  behaviour change; everything else preserves current output exactly.
- T4's live check is AC8 — the classification is judged against this host's
  actual containers, not against my reading of the docker docs.

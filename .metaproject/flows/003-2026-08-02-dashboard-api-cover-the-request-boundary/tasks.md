# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Locate the boundary decisions and demonstrate the containment gap |
| T2 | implement | Write `utils/request-guards.ts` and migrate the five call sites |
| T3 | test | Cover all six functions, with the demonstrated escape as a regression case |
| T4 | review | Verify (typecheck, lint, tests, health, live fetch), draft PR, Codex review |

## Notes

- T1 is complete: the sites and the demonstrated escape are in `context.md`.
- T2's only behaviour change is the containment fix. Everything else moves
  verbatim, including the git-ref regex and the `..` blacklist.
- T4's live fetch is AC9: nothing tests the wiring between the router and
  these guards, so tightening containment has to be confirmed against a
  running server, not just a unit test.

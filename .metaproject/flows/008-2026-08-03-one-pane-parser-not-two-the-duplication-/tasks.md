# Tasks

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Establish what the two monitors share and where they have drifted |
| T2 | implement | Write `utils/pane-parse.ts` and rewire both monitors |
| T3 | test | Cover every branch of the parser |
| T4 | review | Draft PR and Codex review |

## Verification tasks

These exist because flow 005 wrote its verification into `plan.md`, skipped
it, and shipped a change that could not work. Prose blocks nothing; tasks gate
`flow complete`.

| ID | Kind | Title |
|----|------|-------|
| T5 | review | `bun run dupes`: no pattern shared by the two monitors, total down by twelve |
| T6 | test | Status block byte-identical on real recorded pane output, before vs after |

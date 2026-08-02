# Tasks

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Demonstrate the waiting-phase false positive against the real logic |
| T2 | implement | Write `utils/status-format.ts` and rewire `channel/status.ts` |
| T3 | test | Cover all five, with the four misclassifications as regressions |
| T4 | review | Verify, draft PR, Codex review |

## Notes

- T1 is complete: the four cases and their outputs are in `context.md`.
- T2's only behaviour change is where `detectPhase` looks for permission words.
- T3 must carry the real permission-dialog text, not a paraphrase: losing a
  genuine 💬 is far worse than the false ones this flow removes.

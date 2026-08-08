# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `bun run typecheck` exits 0 and `bun run lint` reports 0 errors.
- AC2: `bun test tests/unit/` passes, including new tests for the unknown-kind paths.
- AC3: `runOne` dispatches `codex`, `claude` and `provider` explicitly; a reviewer with any other kind returns a failed ReviewerReport (`ok: false`) whose error names the stored kind, and never calls callProviderReview.
- AC4: `reviewerAvailability` reports a reviewer with an unrecognised kind as unavailable with the same named-kind detail, and does not report it as `unknown provider`.
- AC5: A `provider` reviewer whose `providers` row is genuinely missing still reports `unknown provider` in both paths — the new branch does not swallow it.
- AC6: Adding a fourth ReviewerKind without wiring it into `runOne` is a typecheck error, not a silent fallthrough.

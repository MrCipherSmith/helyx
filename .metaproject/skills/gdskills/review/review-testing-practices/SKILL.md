---
name: review-testing-practices
description: |
  Use when reviewing unit, integration, Storybook, component, or e2e tests
  against repository-local testing conventions: co-location, network mocking,
  MSW-style boundary mocks, behaviour assertions, deterministic waits,
  smoke/full split, locator priority, and screenshot-test discipline.
  Dispatched by review-orchestrator for --testing-practices,
  --project-conventions, --all, or changed test/e2e/story files.
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
---

# Review — Testing Practices

Reviewer for local testing discipline. Read project test guides first when present, then apply
the neutral baseline below.

---

## Scope

Applicable paths commonly include:

- `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/*.spec.tsx`
- `**/*.integration.test.ts`, `**/*.integration.test.tsx`
- `**/*.msw.ts`, `test/**`, `src/test/**`
- `*.stories.tsx`, Storybook specs
- `e2e/**`, Playwright/Cypress page objects and fixtures

If the repository has local test documentation, cite the relevant convention in findings.

---

## Checklist

### Test Location and Tiers

- Tests live near the code they cover unless the repository has a deliberate central test layout.
- Shared test infrastructure folders are not used as buckets for feature tests.
- Unit, integration, component, and e2e tiers are named and routed consistently.
- Fast feedback lanes stay fast; screenshot/component/e2e suites are not used for cheap unit
  assertions.
- Coverage gates focus on changed risk, not low-value tests for trivial getters.

### Network and Boundary Mocking

- For data-fetching UI, prefer rendering the real component/store and mocking only the network
  boundary.
- Avoid mocking the API module in integration tests when the repository has network-level mock
  infrastructure.
- Unhandled network requests fail loudly instead of silently hitting the real world.
- Mock handlers/fixtures are colocated and reusable by tests/stories where practical.
- Handler paths match the runtime test environment and avoid hard-coded origins unless required.

### Behaviour Assertions

- Assert on user-visible DOM, callbacks, toasts, emitted events, or public state.
- Do not reach into private methods or internal fields unless the unit under test is explicitly a
  low-level utility.
- Store-internal timing and concurrency can be unit-tested with lower-level mocks when that is
  the clean seam.

### Browser and E2E Determinism

- Tests create their own artifacts with unique names and assert on those artifacts.
- Avoid mutating or deleting seeded/shared environment data.
- Avoid env-wide assertions such as exact global counts, `.first()`, or `.nth(N)` unless the test
  owns the full dataset.
- No fixed sleeps; wait on assertions, events, responses, or polling predicates.
- Backend-dependent assertions wait on the response/event that proves the backend completed.
- Smoke tags are reserved for fast, reliable, load-bearing baseline flows.
- Locator priority prefers stable test ids and accessible roles over raw CSS selectors.
- Screenshot tests are avoided for heavy, unstable, or non-deterministic surfaces unless the
  repository explicitly supports them.

### Local Type and Build Gotchas

- Account for incremental compiler caches when validating newly added files.
- Generated/vendored files that are outside the lint/type project are ignored centrally rather
  than hand-formatted into compliance.

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

A finding anchored to one `file:line` is a claim about one site. The recorded
history of this repository is that a fix then repairs that site and leaves its
siblings: one writer of five, one operator instruction of four, six readers of
eight. Each was found by the *next* review round, which is why reviews here have
run to seven and four rounds instead of one.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it: enumerating the class for every low-severity
observation is theatre, not rigour.

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/test.ts:line
- **Problem**: which testing rule is violated
- **Why it matters**: determinism, confidence, CI runtime, or maintenance impact
- **Fix**: concrete test rewrite or fixture/handler change
```

Severity guidance: real-network leaks, shared-data mutation, fixed sleeps, and backend-race
assertions are usually `major` or `blocker`; substrate choice and smoke tagging are usually
`minor` unless they make CI flaky.


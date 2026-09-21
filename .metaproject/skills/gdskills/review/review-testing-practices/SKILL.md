---
name: review-testing-practices
model_tier: standard
description: |
  Use when reviewing unit, integration, Storybook, component, or e2e tests
  against repository-local testing conventions: co-location, network mocking,
  MSW-style boundary mocks, behaviour assertions, deterministic waits,
  smoke/full split, locator priority, and screenshot-test discipline.
  Runs a bounded mutation pass over the gates the diff added, so a suite that
  cannot fail is found by executing it rather than by reading it.
  Dispatched by review-orchestrator for --testing-practices,
  --project-conventions, --all, or changed test/e2e/story files.
  NOT for: the correctness of the production code a suite covers (review-logic),
  or naming and readability inside a test with no effect on what it pins
  (review-style).
triggers:
  - "test review"
  - "testing practices"
  - "coverage quality"
  - "review tests"
  - "review testing practices"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
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

## The mutation pass — run this before you read anything

Reading a suite tells you whether it is *well written*. It does not tell you
whether it can **fail**. Those are different questions, and the second one is the
one this reviewer exists to answer.

So: before the checklist, for every guard, filter, conditional or branch the diff
**added or changed**, delete it, run the nearest suite, record the result, revert.

```
for each gate G added or changed in scope A:
    delete G  ->  run the nearest suite  ->  record red/green  ->  revert
```

**A gate whose deletion leaves the suite green is a finding**, however correct the
gate itself is. State it as: *this gate is unpinned; no fixture builds the input
that separates it from the condition beside it.* It is mandatory when the gate was
added in answer to an earlier round — that is where a regression costs most and
where coverage is most often assumed rather than written.

Publish the whole table, survivors and casualties both. The reds are what makes
the greens mean something; a table with only survivors reads as cherry-picking.

| mutation | result |
|---|---|
| delete the `(half.weight ?? 0) > 0` filter | **18/18 green** |
| `controlsScore` -> `report.score` | 2 fail |
| drop `Math.min(100, …)` | 1 fail |

### Why this is your job and not the verifier's

`review-verifier` also executes — but it is **delete-only**: it confirms or refutes
findings that already exist. A surviving mutation is not a verdict on a finding,
it *is* the finding, and nothing downstream of you can produce one. If you skip
this pass the class is unreachable for the whole round.

### Bounds

- Mutate only gates inside **scope A**, one at a time, reverting each before the
  next. Never leave a mutation in the tree.
- Run the **nearest** suite, not the full one. This is not a `test:mutation`
  sweep — those are slow, opt-in, and answer a different question.
- Cap it: the gates the diff added, plus any gate a previous round asked for. If
  that set is larger than your budget, take the previous-round gates first and say
  in your summary how many you did not reach. A stated cap is a result; silence
  reads as a clean sweep.
- If you cannot run the suite at all, say so and skip the pass. Do **not** report
  a mutation you did not run — a predicted result is `info` at best, and this
  reviewer has no use for one.

### This does not replace reading the tests

Assertion duplication and mutation survival are independent: a suite can be free
of duplication, correctly tiered, properly mocked — and still pin nothing. Run the
pass, then work the checklist.

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

### Fixture Shape Against the Producer

- For every fixture whose name or comment claims a scenario — `drift-only`, `legacy
  report`, `never run` — find the **producer** (the backend class, the builder, the
  API contract) and compare **every** field, not only the one the test pins.
- A fixture that calls itself X while carrying the shape of Y covers Y, leaves X
  untested, and reads to the next author as coverage of X. That is worse than no
  fixture: it is coverage that lies.
- Cheapest tell: the fixture sets one field to the scenario's value and inherits
  the rest from a default builder written for a different scenario.
- Name the field that disagrees and the producer line that settles it. If the
  producer lives in another repository, pin the SHA you read it at. If you cannot
  read it, the finding is `info` and says what would settle it.
- A value the producer **cannot emit** (a score of 40 where the backend rounds to
  tens, two weights summing to 200) is the same class: the test pins a state that
  does not exist, so it cannot catch the state that does.

### Branch Under Test

- When the code under test chooses between sources — a preferred one and a
  fallback — establish which branch the fixture actually drives.
- A comment of the form *"this copy is the authoritative one, the other is a
  fallback"* is a direct instruction that the test must go through the preferred
  branch. Assertions that all ride the fallback while the preferred source is
  authoritative leave the suite green in exactly the failure the comment warns
  about.
- Look for the preference in **the code under test, not in the test**. The test
  cannot tell you which branch it takes; the selector can.
- Same shape, one level up: a test that asserts only falsy state — "not open",
  "not present", "no toast" — passes trivially when the code path never ran. Each
  such test needs one positive artifact proving the path was entered before the
  negative assertions mean anything.

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

## Iron Laws

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot
   name the input, call, or condition that reaches the code, you have an
   observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code
   under review. Do not report a safe API because it could be misused, or a
   pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears
   at several sites, report it once and list every site. Ten findings that are one
   finding hide the other nine problems.

Severity levels are defined once, in `review-orchestrator/SKILL.md` →
**Severity (canonical)**. This reviewer does not restate them: `blocker` is the
four merge-blocking shapes named there and nothing else, and the `major`/`minor`
boundary is the trigger-and-outcome test.

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

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

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no rubric of its own; what follows is where its recurring
conditions land under that rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| A test that passes while the behaviour it names is broken | `blocker` | The acceptance criterion is unimplemented — the test only claims otherwise |
| Real-network leak; shared-data mutation across tests; fixed sleeps; asserting on a backend race | `major` | Named trigger (the run) and named outcome (flake or a false pass) |
| A gate the diff added survives deletion with the suite green | `minor` | The code is correct; the cost is that the next edit to it is unprotected |
| A fixture whose shape contradicts the scenario it names, or pins a value the producer cannot emit | `minor` | Same — plus the next author reads it as coverage it does not provide |
| Assertions ride the fallback branch while the code names another authoritative | `minor` | Same |
| Substrate choice, smoke tagging, locator priority, co-location | `minor` | The suite is correct; the cost is to whoever maintains it |
| A convention preference with no effect on determinism or signal | `info` | Shared laws 1 and 2 |

A flaky test is `major`, not `blocker`: it wastes time, but it does not ship a
defect. A test that cannot fail does — which is why it is the one `blocker` here.

The three mutation-pass rows sit at `minor` deliberately, and the reasoning is
the canonical rubric rather than modesty: a coverage gap names no runtime trigger
and no user-visible outcome, so it cannot be `major` under the boundary test. What
makes them worth reporting is not severity but **evidence class** — each one is a
command that ran, which is the rarest thing in a review and the only kind of
finding a later round cannot argue away. Report them with the mutation and its
result, and they survive adjudication intact. Report them as "coverage looks
thin" and they are correctly discarded.

The moment a surviving mutation is accompanied by a **reachable input that makes
the unpinned code do the wrong thing**, that is a separate finding at the severity
its own outcome earns — usually `major`. The coverage gap and the defect are two
findings, not one, and conflating them loses whichever the adjudicator disbelieves.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The suite is green, so the tests pin the behaviour." | Green is the state before the mutation pass, not its result. Delete the gate, run the nearest suite, and report what happened — that is the one question this reviewer exists to answer. |
| "I could not run the suite, so I worked out what the mutation would do." | A predicted mutation is `info` at best and this lane has no use for one. Say which command you ran, what stopped it, and skip the pass — do not report a result you did not observe. |
| "I only published the mutations that survived; the rest were noise." | The reds are what makes the greens mean something. A table of survivors alone reads as cherry-picking and will be discounted whole. |
| "The fixture is named `drift-only`, so it covers the drift case." | The name is the claim under review. Open the producer and compare every field, not only the one the test pins; a fixture that carries another scenario's shape is coverage that lies. |
| "Mocking the API module is simpler than standing up the network boundary." | It also deletes the layer where the bug lives — serialisation, status handling, the error path. Simpler is the reason the convention exists to overrule. |
| "This test is flaky, that is a `blocker`." | Flake wastes time; it does not ship a defect. `major`. The one `blocker` in this lane is a test that cannot fail while the behaviour it names is broken. |
| "I mutated more gates than my budget allowed, but I got through most of them." | Say how many you did not reach. A stated cap is a result; silence reads as a complete sweep and the next round inherits the gap without knowing it. |

---

## Verification

Report done only once all of these hold:

- The mutation table is published in full, survivors and casualties both, or the
  report says which command failed and that the pass was skipped.
- The report states the cap: how many added or previously-requested gates were
  mutated and how many were not reached.
- Every finding names `file:line` and the evidence that settles it — the mutation
  and its result, the producer line, or the selector that names the branch.
- Every `blocker` and `major` carries `class_scope` with `sites` and an
  `enumeration_method` naming the search that produced them.
- No finding invents a severity: each lands under **Severity (canonical)** in
  `review-orchestrator/SKILL.md`, and a coverage gap is filed separately from any
  defect it exposes.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, or
  `NEEDS_CONTEXT` naming the context that was missing — never a guess in its place.


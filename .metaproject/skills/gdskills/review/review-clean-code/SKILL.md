---
name: review-clean-code
description: |
  Use when: reviewing code against Clean Code principles (Uncle Bob) and SOLID at the
  function/class level — meaningful names, small functions, single level of abstraction,
  argument count, error handling, DRY, comment quality, and SOLID (SRP, OCP, LSP, ISP, DIP)
  as applied to individual classes and functions.
  Triggered by: "review clean code", "check clean code", "Uncle Bob review", "SOLID review",
  "review --clean-code", or dispatched by review-orchestrator.
  NOT for: architectural layer violations (review-architecture), naming convention formatting
  (review-style), logic correctness bugs (review-logic), or security (review-security-code).
version: "1.0.0"
triggers:
  - "review clean code"
  - "check clean code"
  - "Uncle Bob review"
  - "SOLID review"
  - "review --clean-code"
  - dispatched by review-orchestrator
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Review: Clean Code + SOLID

Specialized reviewer for **Clean Code principles** (Robert C. Martin) and **SOLID** at the
function and class level. Focuses on code in the current branch diff only.

The goal is not stylistic nitpicking — every finding here points to a concrete
maintainability, readability, or extensibility problem that will cause friction
as the codebase grows.

---

## Workflow

```
Clean Code Review Progress:
- [ ] Step 1: Read Job Context (if provided)
- [ ] Step 2: Determine git scope (merge-base)
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: Meaningful Names check
- [ ] Step 5: Functions check (size, abstraction, arguments)
- [ ] Step 6: Comments check
- [ ] Step 7: Error Handling check
- [ ] Step 8: DRY check
- [ ] Step 9: SOLID check (SRP, OCP, LSP, ISP, DIP)
- [ ] Step 10: Emit findings in unified format
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit hash or range. Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document. Read before reviewing. |

---

## Scope Detection

See shared script: `skills/shared/git-merge-base.md`

Run the script to determine `BASE_SHA`, then collect the diff:

```bash
git diff --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

Review scope: **only code introduced or modified in this branch since merge-base**.
Pre-existing problems in unchanged lines are out of scope unless a change directly
worsens them.

---

## Iron Laws

1. **Findings without a specific `file:line` from the diff are not valid findings.** Never cite general observations about the codebase.
2. **Max severity for a naming issue is `major`.** Pure naming never rises to `blocker` — reserved for issues that break correctness.
3. **DRY violations require at least 3 repetitions before becoming `major`.** Two occurrences can be accidental; three is a pattern.
4. **SOLID opinions without a named principle and a concrete violation description are `info` only.** State the principle (e.g., SRP), the two responsibilities, and the impact.
5. **Do not flag language idioms or framework conventions as Clean Code violations.** If it is the standard way to do something in TypeScript / NestJS / React, it is not a violation.

---

## Review Checklist

### Part A: Meaningful Names

The central test: **a name should tell you why it exists, what it does, and how it is used** — without needing a comment to explain it.

#### A1. Intention-Revealing Names

- [ ] Variable / parameter names that require a comment to understand their purpose
- [ ] Single-letter names outside loop counters (`i`, `j`, `k`) and conventional math variables
- [ ] Generic names that carry no information: `data`, `info`, `value`, `temp`, `result`, `obj`, `item`, `thing`, `stuff`, `helper`, `util`, `manager`, `processor`
- [ ] Boolean names that could be read as either true or false: prefer `isLoaded`, `hasError`, `canSubmit` over `loaded`, `error`, `submit`
- [ ] Function names that start with a vague verb: `do`, `handle`, `process`, `manage` — prefer verbs that describe the action: `parseConfig`, `validateToken`, `fetchUserById`

Flags:
- Single-letter variable outside loop — **minor**
- Generic meaningless name (`data`, `result`, `temp`) in new code — **minor**
- Boolean named without `is/has/can/should` prefix making polarity ambiguous — **minor**
- Function named `handleX` where X is also vague — **minor**

#### A2. Searchability and Length

- [ ] Names that are too short to be grepped: single letters or two-letter abbreviations for non-obvious concepts
- [ ] Names that are too long (>40 characters) adding noise without precision: prefer concise + precise over exhaustive
- [ ] Abbreviations that are not project-wide standards (`usr` for `user`, `cnt` for `count`, `cfg` for `config`)

Flags:
- Non-standard abbreviation that a new team member would need to decode — **minor**

#### A3. Consistent Vocabulary

- [ ] Same concept named differently in the same diff: `user` / `account` / `member` used interchangeably for the same domain entity
- [ ] Verb inconsistency for similar actions: `fetch` vs `get` vs `load` vs `retrieve` for the same type of operation in the same module
- [ ] Antonym inconsistency: if one side is `add`, the other should be `remove` — not `delete` / `destroy` / `clear`

Flags:
- Two names for the same concept in the same diff — **minor**

---

### Part B: Functions

#### B1. Function Size and Single Responsibility

Clean Code guideline: functions should do **one thing** at one level of abstraction.

- [ ] Function body exceeds ~20 lines: a strong smell that it does more than one thing
- [ ] Function mixes levels of abstraction: high-level orchestration next to low-level data manipulation in the same block
- [ ] Function that both queries data AND transforms it AND persists it (three responsibilities)
- [ ] Functions with a `And` or `Or` in the name, describing two operations

Flags:
- Function body >40 lines — **major** (clear overload; flag specific function by name)
- Function body 20–40 lines with visible mixed abstraction — **minor**
- `doXAndY()` naming explicitly stating two operations — **minor**

#### B2. Function Arguments

- [ ] Monadic (1 arg): ideal for transformations (`parseDate(str)`) and predicates (`isEmpty(list)`)
- [ ] Dyadic (2 args): acceptable when arguments form a natural ordered pair (`createPoint(x, y)`)
- [ ] Triadic (3 args): consider if a config/options object would read more clearly
- [ ] Polyadic (≥4 args): almost always a sign of a missing abstraction (config object, parameter object, or SRP violation)
- [ ] Boolean flag arguments: `renderWidget(true, false, true)` — split into separate functions or use named option objects
- [ ] Output arguments: a function that mutates its argument instead of returning a value (`populate(result)`)

Flags:
- Function with ≥4 parameters not using an options/config object — **major**
- Boolean flag parameter (`enabled: boolean`) passed to control function flow — **major** (split into two functions)
- Output argument (mutating parameter instead of returning) — **minor**
- Three parameters where a plain named object would be clearer — **minor**

#### B3. Abstraction Level Consistency

Each function should stay at one level of the abstraction ladder. A function that opens a file, reads its bytes, decodes UTF-8, splits lines, and validates each record mixes at least 3 levels.

- [ ] Inline low-level operations (string splitting, index arithmetic) inside a high-level orchestration function
- [ ] High-level domain concepts (`createUserAccount`) containing raw SQL or HTTP fetch calls instead of delegating to a repository/service

Flags:
- High-level function with low-level implementation detail mixed in — **minor**

---

### Part C: Comments

#### C1. Comments That Lie or Are Redundant

- [ ] Comment that repeats what the code already says: `i++ // increment i`
- [ ] Comment that is stale / no longer matches the current code
- [ ] Commented-out code left in the diff

Flags:
- Redundant comment restating the code — **minor**
- Stale comment contradicting the code — **major** (actively misleads readers)
- Commented-out code block — **minor** (use git history, not comments, to preserve old code)

#### C2. Comments That Compensate for Bad Names

A comment whose entire purpose is to explain a poorly-named identifier is a sign to improve the name, not add a comment.

- [ ] `// This is the pipeline execution queue` explaining a variable named `queue2`
- [ ] JSDoc `@param data The data to process` adding zero information

Flags:
- Comment exists only to explain a name that could be made self-documenting — **minor**

#### C3. Comments That Are Justified

These are the correct uses of comments — do NOT flag:
- Legal comments (license headers)
- Explanation of intent for a non-obvious algorithm or business rule
- Clarification of a subtle domain constraint (`// ISO week starts on Monday per business requirement`)
- Warning about consequences (`// Do not cache — response contains time-sensitive token`)
- TODO/FIXME with an issue reference (`// TODO(#1234): remove after migration`)

---

### Part D: Error Handling

#### D1. Error Types and Propagation

- [ ] Returning `null` or `undefined` to signal failure instead of throwing or using a Result type — causes null propagation and eventual NPE
- [ ] Swallowing exceptions: `catch (err) {}` with no logging or re-throw
- [ ] Logging AND re-throwing the same error — double-logs across callers
- [ ] Using error strings instead of typed errors: `throw new Error("NOT_FOUND")` — callers cannot pattern-match
- [ ] `catch (err: any)` — loses type safety; use `catch (err: unknown)`

Flags:
- `catch` block with empty body or only a comment — **major** (silent failure)
- Returning `null` / `undefined` from a function to signal "not found" in a critical path — **major**
- Log + rethrow in the same catch block — **minor**
- Untyped error in catch — **minor**

#### D2. Error Context

- [ ] Re-throwing an error without wrapping context: `throw err` loses the call site information; prefer `throw new AppError("context", { cause: err })`
- [ ] Generic `new Error("something went wrong")` — message must identify what went wrong and ideally what inputs caused it

Flags:
- Bare `throw err` re-throw losing context in a library/service boundary — **minor**
- Generic error message with no context — **minor**

---

### Part E: DRY (Don't Repeat Yourself)

#### E1. Code Duplication

- [ ] Identical or near-identical code blocks in ≥3 places in the diff
- [ ] Copy-pasted logic that differs only in one or two variable names
- [ ] Multiple functions doing the same transformation with slightly different wrapping

Flags:
- 3+ identical or near-identical blocks in the diff that could be extracted — **major**
- 2 occurrences — **minor** (note, do not raise unless the pattern is clearly intentional duplication)

#### E2. Magic Numbers and Strings

- [ ] Hardcoded numeric literal used in business logic with no named constant (`if (status === 3)`)
- [ ] Repeated string literal used as a key, type discriminant, or route path without a shared constant

Flags:
- Magic number in business logic (not an obvious neutral like `0`, `1`, `100`) — **minor**
- Repeated string constant defined inline in multiple places — **minor**

---

### Part F: SOLID (at function/class level)

This overlaps with `review-architecture` at the system level, but here the focus is on
**individual classes and functions**, not module structure or layer assignments.

#### F1. Single Responsibility Principle (SRP)

A class should have **one reason to change**: one owner (one part of the system that drives its evolution).

- [ ] Class responsible for both data access AND business logic
- [ ] Class responsible for both input validation AND output formatting
- [ ] A constructor that does real work: making network calls, reading files, computing state — constructors should only assign

Flags:
- Class with two clearly distinct responsibilities that have different change drivers — **major**
- Constructor performing I/O or async operations — **major**
- Service method doing validation + transformation + persistence inline — **minor**

#### F2. Open/Closed Principle (OCP)

Classes should be open for extension, closed for modification. Violations appear as chains that must grow every time a new case is added.

- [ ] `if/else if` or `switch` over a type discriminant that already has 3+ branches — consider a strategy/visitor pattern
- [ ] Adding a case to an existing long `switch` in a file not in the diff context — flag if the diff shows a new `case` in a multi-case switch

Flags:
- New `case` added to a switch with ≥4 existing cases where a strategy pattern would be more appropriate — **minor**
- `instanceof` chain (`if (x instanceof A) ... else if (x instanceof B)`) — **minor**

#### F3. Liskov Substitution Principle (LSP)

Subtypes must be substitutable for their base types without changing the program's behavior.

- [ ] Subclass `override` method that throws `NotImplementedException` or `UnsupportedOperationException`
- [ ] Subclass method that requires checking `instanceof this` to determine behavior
- [ ] Override that strengthens preconditions (rejects more inputs than the parent)
- [ ] Override that weakens postconditions (returns less than the parent guarantees)

Flags:
- Override throwing "not supported" — **major**
- Override requiring `instanceof` self-check — **major**

#### F4. Interface Segregation Principle (ISP)

Clients should not be forced to depend on methods they do not use.

- [ ] Interface with ≥7 methods where implementing classes use only a subset — split into smaller interfaces
- [ ] Abstract class method that all concrete subclasses implement as a no-op

Flags:
- Interface with methods that have stub/no-op implementations in subclasses — **minor**

#### F5. Dependency Inversion Principle (DIP) — at class level

High-level modules should not depend on low-level modules. Both should depend on abstractions.

- [ ] Class instantiating its own dependencies with `new` instead of receiving them via constructor injection
- [ ] Class importing a concrete implementation class from another module instead of an interface/abstract class

Flags:
- `new ConcreteService()` inside a class method that should receive it via DI — **major**
- Import of concrete implementation where an interface or abstract type exists — **minor**

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Meaningful names, function size, DRY, comments, error handling | YES | — |
| SOLID at function/class level | YES | — |
| Layer violations, module coupling, dependency direction | NO | `review-architecture` |
| Style: naming convention formatting (casing, prefix) | NO | `review-style` |
| Logic bugs, off-by-one errors, null-safety | NO | `review-logic` |
| Security vulnerabilities | NO | `review-security-code` |
| Performance anti-patterns | NO | `review-performance` |
| React/MobX-specific frontend patterns | NO | `review-frontend` |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Principle**: Clean Code — Meaningful Names A1 | SOLID — SRP F1 | etc.
- **Problem**: what is wrong and why it matters
- **Fix**: concrete actionable suggestion
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

Severity guide for this reviewer:

| Severity | When to use |
|----------|------------|
| `blocker` | Swallowed exception (silent failure); constructor performing I/O that prevents testing; LSP violation breaking substitutability at runtime |
| `major` | Function >40 lines; ≥4 parameters without options object; boolean flag arg; class with two distinct responsibilities; `new ConcreteService()` bypassing DI |
| `minor` | Poor naming; redundant comment; magic number; 20–40 line function; minor OCP/ISP smell; log+rethrow |
| `info` | Stylistic opinion; potential future issue with no current concrete violation |

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

```markdown
## Clean Code Review

### Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Changed files reviewed: <N>

### Summary
<2-3 sentences: overall code health relative to Clean Code principles, key concerns.>

### Stats
- blocker: N  |  major: N  |  minor: N  |  info: N

### Findings

#### Naming
<[F-NNN] findings or "No naming issues found.">

#### Functions
<[F-NNN] findings or "No function design issues found.">

#### Comments
<[F-NNN] findings or "No comment issues found.">

#### Error Handling
<[F-NNN] findings or "No error handling issues found.">

#### DRY
<[F-NNN] findings or "No DRY violations found.">

#### SOLID
<[F-NNN] findings or "No SOLID violations found.">

### Clean Areas
[List parts of the checklist with no findings, confirming they were reviewed]
```

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before reviewing. Use it to:
- Understand team-agreed naming conventions that may differ from defaults
- Identify intentional design decisions that appear to violate Clean Code but are documented exceptions
- Understand error handling strategy (Result types vs. exceptions vs. null)

If absent, proceed normally — context is optional and non-blocking.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "This function is long but it's clear" | Clarity and length are separate concerns; long functions are harder to test and change regardless of clarity |
| "The team knows what `data` means here" | Names must survive team turnover; if a newcomer can't understand it, it fails |
| "DRY isn't violated — the two blocks just happen to look the same" | If they change together and must stay in sync, they are a DRY violation |
| "Boolean arg is fine, it's obvious from context" | Boolean args always create `call(true, false, true)` call sites that require reading the signature to decode |
| "The catch block logs the error, that's enough" | Logging and silently swallowing are the same if nothing else handles it — check what happens after the catch |
| "I can flag SOLID issues at info because they're just design opinions" | Named SOLID violations with concrete impact (testability, extensibility) are at least minor |
| "This is how the framework works, so it's not a violation" | Framework idioms are explicitly exempt — Iron Law 5 |

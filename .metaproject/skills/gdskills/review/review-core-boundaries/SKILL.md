---
name: review-core-boundaries
model_tier: deep
description: |
  Use when reviewing shared core/infrastructure module changes for dependency
  direction, feature-boundary leakage, abstraction stability, composition,
  and blast-radius risks. Dispatched by review-orchestrator for
  --core-boundaries, --project-conventions, --all, or src/core/** changes.
  NOT for: logic correctness in code that happens to live in core (review-logic),
  naming and readability (review-style), or SOLID and layering inside a feature
  module (review-architecture).
triggers:
  - "core review"
  - "shared boundary"
  - "public surface"
  - "review core boundaries"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
---

# Review — Core Boundaries

Reviewer for shared infrastructure modules. A core module should provide stable foundations
used by feature modules; it should not accumulate feature-specific behaviour.

---

## Scope

Applicable to folders such as `src/core/**`, `core/**`, `shared/**`, `foundation/**`,
or whatever the repository documents as its shared infrastructure layer.

If a more specific module reviewer also applies, run both.

---

## Checklist

- Shared/core modules contain reusable utilities, base components, base stores, primitives, and
  infrastructure.
- Feature-specific code does not move into core just to avoid imports.
- Core does not import feature/domain modules.
- Dependencies stay minimal and point inward: feature modules depend on core, not the reverse.
- Prefer composition through interfaces, base classes, adapters, or callbacks over hard-coded
  feature knowledge.
- Public core APIs remain stable and domain-neutral.
- New exports are added only when there is a real shared consumer need.
- Changes are conservative because core has broad blast radius.
- Generic helpers remain generic; names, types, and state do not leak a single feature's language.
- Resource-owning utilities document and test cleanup semantics.

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
- **File**: path/to/core/file.ts:line
- **Problem**: core boundary or stability rule violated
- **Why it matters**: blast radius across modules
- **Fix**: move to domain module, invert dependency, or extract a truly shared abstraction
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no rubric of its own; what follows is where its recurring
conditions land under that rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| A core API change that breaks a named consumer at runtime | `blocker` | Crash at a named call site |
| Importing feature code into core; adding feature-specific public API to core; inverted dependency | `major` | Named trigger (the import) and named outcome (the cycle or the leak), but structural — not one of the four shapes |
| A generic helper whose names or types lean on one feature's language | `minor` | Works today; the cost is to the next module that needs it |
| A blast-radius concern with no named consumer | `info` | Shared law 1 |

"Broad blast radius" is not by itself a `blocker`. Name the consumer that breaks.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "It is generic enough to live in core." | Generic enough is not shared. Name the second consumer that needs it today; one feature's helper parked in core is exactly the leak this lane exists to catch, whatever the file is called. |
| "Core has broad blast radius, so this is a `blocker`." | Blast radius is a property of the module, not of the change. Name the consumer that breaks and what breaks in it, or it is `info` under shared law 1. |
| "It is only a type import, so core does not really depend on the feature." | The import is in the source and in the build graph. Delete the feature module and core stops compiling — direction is decided by what core names, not by what survives type erasure. |
| "The new export has one consumer today, so the surface is still stable." | A public core export is a contract with every module that installs it. One consumer is the argument for keeping the helper internal, not for exporting it. |
| "I cannot enumerate every consumer of a core symbol, so I will anchor the finding at the file the diff touched." | Consumers of a core export are precisely what a search enumerates. A `class_scope` with no `enumeration_method` is the one-site fix that leaves the siblings for the next round. |
| "The move into core is temporary — it gets extracted properly later." | Nothing downstream records that intent, and a core import is load-bearing the moment it ships. Rate the code in the diff, not the plan described beside it. |

---

## Verification

Report done only once all of these hold:

- Every finding names `file:line` and the evidence that settles it — the import,
  the export, or the consumer — quoted from the tree rather than described.
- Every `blocker` and `major` carries `class_scope` with `sites` and an
  `enumeration_method` naming the search that produced them.
- No finding invents a severity: each lands under **Severity (canonical)** in
  `review-orchestrator/SKILL.md`.
- Every blast-radius claim names the consumer that breaks. Unnamed ones are
  `info`, and say what would settle them.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, or
  `NEEDS_CONTEXT` naming the context that was missing — never a guess in its place.


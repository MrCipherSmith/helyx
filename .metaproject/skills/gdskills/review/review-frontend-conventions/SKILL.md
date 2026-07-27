---
name: review-frontend-conventions
description: |
  Use when reviewing frontend code against repository-local conventions commonly
  captured in CLAUDE.md or similar project guides: React/MobX boundaries,
  TypeScript strictness, i18n placement, storage wrappers, error handling,
  styling tokens, Storybook expectations, and local tooling rules. Dispatched
  by review-orchestrator for --frontend-conventions, --project-conventions,
  --all, or frontend src/**/*.ts(x) changes when local convention docs exist.
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
---

# Review — Frontend Conventions

Reviewer for frontend repository conventions that are more specific than generic React/MobX
correctness. Use it alongside `review-frontend`, `review-style`, `review-performance`, and
`review-logic`.

Before reviewing, read the nearest project guide files if they exist: root `CLAUDE.md`,
`AGENTS.md`, `.junie/guidelines.md`, `ARCHITECTURE.md`, and module-level `CLAUDE.md` files.
The checklist below is a neutral baseline; local project rules win when they are stricter.

---

## Scope

Review changed frontend source, stories, tests, and UI wrapper files for local conventions.
Do not flag unrelated generic React/MobX issues unless they also violate a local convention or
the baseline below.

If no local convention document exists, run only the neutral baseline and state that no
project-specific guide was found.

---

## Checklist

### Styling and UI

- Prefer the repository's styling system consistently (Tailwind, CSS modules, design tokens, or
  the established local framework).
- Avoid inline `style` except for genuinely dynamic positioning or third-party integration seams.
- Theme colors and spacing come from local tokens, not ad hoc literals.
- Use the established UI kit and wrapper layer; do not bypass shared wrappers without a reason.
- Reuse existing icons/assets before adding new ones.

### TypeScript

- Avoid `any` and broad `as` casts. Prefer type guards, discriminated unions, and precise types.
- Keep tests and stories typed unless intentionally exercising invalid edge cases.
- Follow local React type import conventions consistently.
- Write new code in the direction of stricter compiler settings.

### React Components

- Keep components thin: read state, bind events, render.
- Business logic, IO, validation, and data transformation belong in stores/services.
- Avoid React local state/memo/callback hooks where the local architecture expects observable or
  computed state.
- Use effects only for lifecycle, subscriptions, and third-party integration; always clean up.
- Components reading observable state are wrapped in the repository's reactive wrapper.
- Props shape and file naming follow local conventions.

### State Stores

- Store classes follow local naming, file casing, context, and hook conventions.
- Observable classes initialize their reactivity in constructors.
- Member ordering follows local lint/member-ordering rules.
- UI-called actions preserve `this` binding.
- Async callbacks that mutate observable state re-enter an action boundary.
- Derived serializable state has a single source of truth such as `currentState` when that is the
  local pattern.

### i18n, Storage, and Errors

- Translations happen at the view/render boundary unless local architecture says otherwise.
- Do not hide missing translations with inline fallbacks when the project expects JSON/catalog
  entries.
- Browser storage goes through shared wrappers/adapters; direct `localStorage`/`sessionStorage`
  access is a review finding when wrappers exist.
- Catch blocks normalize user-facing messages, preserve original errors for logging, and notify
  through the established UI notification channel.

### Stories and Tooling

- New reusable UI surfaces have stories or examples matching local standards.
- Stories include representative default, empty/minimal, and stress/large states where useful.
- Wrapper components expose plain props for controls when the primary component is store-only.
- Treat unused-code tools as signals: preserve intentional public APIs with narrow ignores rather
  than deleting documented runtime/story/test entrypoints.

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `skills/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what local frontend convention is violated
- **Why it matters**: runtime behavior, maintainability, CI, UX, or developer workflow impact
- **Fix**: concrete project-aligned change
```

Severity guidance: lost reactivity, direct storage quota risk, masked translation/error behavior,
and violations that break CI are `blocker`/`major`; naming/story coverage is usually `minor`
unless it breaks tooling or controls.


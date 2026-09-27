---
name: review-layout
model_tier: standard
description: |
  Use when reviewing changes to rendered layout: flex and grid sizing, intrinsic vs
  extrinsic sizing, overflow and collapse, logical properties and RTL, and sensitivity
  to translated text length. Every finding is measured in a real layout engine, never
  reasoned from class names in a DOM stub. Dispatched by review-orchestrator for
  --layout, --all, or when the diff touches sizing/spacing utilities on a rendered
  element.
  NOT for: whether a class exists or comes from the theme (review-frontend-conventions),
  naming and readability (review-style), re-render cost (review-performance), React or
  MobX structure (review-frontend).
triggers:
  - "layout review"
  - "review layout"
  - "does this render correctly"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review — Layout

Reviewer for what the CSS actually renders.

This lane exists because nobody else owns it. `review-frontend` owns React and
MobX structure; `review-style` explicitly excludes everything but naming and
readability; `review-frontend-conventions` owns whether a class is allowed;
`review-performance` owns re-render cost. **None of them answers whether the box
is the size the author thinks it is** — which is why a bar that collapses to 0px
and a score that sits 12px off centre both shipped through a full review round.

Every finding here is a claim about pixels, so every finding here is measured or
it is not filed.

---

## Scope

Dispatched when scope A touches, on a **rendered** element:

- sizing: `w-*`, `h-*`, `min-w-*`, `max-w-*`, `basis-*`, `flex-*`, `grid-cols-*`,
  `w-fit`, `min-w-0`, `truncate`, `line-clamp-*`
- spacing that participates in centring or the box model: `p*`, `m*`, `gap-*`, and
  their logical forms `ps-*`, `pe-*`, `ms-*`, `me-*`
- `overflow-*`, `position`, `z-*`, `aspect-*`
- inline `style` carrying a computed dimension
- any container whose children render translated text

Out of scope: whether a class exists or comes from the theme, and whether it is
well named.

---

## The one method that makes this lane real

**A DOM stub loads no stylesheet.** Under happy-dom or jsdom,
`toHaveClass("w-fit")` observes a string and never a pixel, and
`getBoundingClientRect` returns zeros for everything. A layout claim reasoned from
class names is worth nothing, and filing one is how this lane degenerates into a
class-name spellchecker.

Verify one of two ways, and put the numbers in the finding:

1. The project's real-CSS tier — the Storybook / Playwright / component-visual
   suite. Find its script in `package.json` rather than assuming a name.
2. A direct probe that mounts the component in a real engine and reads computed
   CSS off the node.

Report a table of measurements, not an adjective. `117.6px` is a finding; "the bar
may be too short" is not.

```
host width   longest label      bar width
560px        "Controls"         256.0px
560px        <longest ar-AE>    182.6px
280px        "Controls"           0.0px   <- collapses
```

**If you cannot measure, you cannot file.** Say which command you tried, what
stopped you, and what would settle it. An unmeasured layout observation is `info`,
marked unverified — that is the correct outcome, not a reason to reach for a class
name instead.

---

## Checklist

### Intrinsic sizing traps

- [ ] A `flex-1` / `basis-0` column inside a `w-fit` (or `max-content`) parent has
      **no basis of its own**: its width is whatever the siblings' content leaves.
      Measure it, then measure it again with the longest translated label the
      catalog contains.
- [ ] `min-w-0` removes the automatic minimum that stops a flex item shrinking past
      its content. Combined with a content-sized parent it permits **0px**. Find the
      host width at which the element reaches zero and state it.
- [ ] `w-fit` + `max-w-full` is an overflow fix, not a sizing floor. Replacing a
      removed `min-w-*` with `min-w-0` trades an overflow bug for a collapse bug.
- [ ] A `min-w-*` on a child plus `w-fit` at the call sites gives the card a hard
      floor. Compute it, and check it against the narrowest supported host.

### Box model and centring

- [ ] Padding inside a fixed-width box shifts centred content by half the asymmetric
      padding. `w-48` (192px) with `pe-6` (24px) centres in 168px — 12px toward the
      inline start.
- [ ] Directional padding that is a gutter in one state is an uncompensated offset in
      the state where the neighbour is absent. Check **every** conditional render of
      that sibling, including the empty and never-run states.

### Logical properties and RTL

- [ ] `ps-*` / `pe-*` / `ms-*` / `me-*` flip under RTL: an offset toward the start in
      LTR is toward the end in RTL. State both.
- [ ] A physical gradient, shadow, or transform in a component that otherwise uses
      logical properties does **not** flip. Name the direction it points in each.
- [ ] Text length differs by locale. A component sized by its own labels renders
      **different geometry for identical data** across locales. Measure with the
      longest real translation in the catalog, never the English one.

### Truncation and overflow

- [ ] `truncate` / `line-clamp` needs a constrained width to do anything at all.
- [ ] `overflow-hidden` on a container with a percentage-width child silently clips
      rather than scrolls.

---

## Iron Laws

### This reviewer's own

1. **A layout finding without a measurement is `info`.** Name the host width, the
   element width or the offset in pixels, and the command or probe that produced it.
2. **Measure the worst real case, not the convenient one.** The longest translation
   in the catalog, the narrowest supported host, the state where the sibling is
   absent, the locale that flips direction.
3. **Never flag a theoretical narrow viewport.** If no supported host reaches the
   collapse width, the finding is `info` and says what would settle it. A breakpoint
   nobody ships is not a trigger.

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
**Severity (canonical)**. This reviewer keeps no rubric of its own; below is only
where its recurring conditions land under that one.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| An element renders at 0px while its label shows, at a supported host width | `major` | Named trigger (that width), named outcome (the control is invisible) |
| Identical data renders different geometry per locale | `major` | Named trigger (the locale), named outcome (a different picture of the same number) |
| Content clipped, or the page forced to scroll horizontally, at a supported width | `major` | Named trigger and outcome |
| A cosmetic offset a user would not notice — a few px off centre | `minor` | The code behaves correctly; the cost is aesthetic |
| A measured-but-unreachable collapse, or any claim you could not measure | `info` | Shared law 1 |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided
`reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible
with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a
concise markdown summary. Prefix finding ids `LY-`.

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` carries `class_scope`: **every** element with the same
sizing shape, and **how you enumerated them** — the search you ran, or the
component whose call sites derive the set.

```yaml
class_scope:
  sites: ["src/dq/components/DqScoreCard.tsx:111", "src/dq/components/DqTrendCard.tsx:88"]
  enumeration_method: "grep for `min-w-0 flex-1` under a w-fit ancestor; 4 cards, 2 collapse"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list is
a claim that the class has exactly one member — make it deliberately.

```markdown
### [LY-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/Component.tsx:line
- **Problem**: what the box does
- **Measurement**: host width, element width or offset, and the command or probe
- **Why it matters**: what the user sees, in which state and which locale
- **Fix**: the concrete sizing change
```

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "`toHaveClass('w-fit')` passes, so the width is right." | The stub loads no CSS. That assertion cannot fail on a layout bug. |
| "This will obviously overflow on mobile." | Measure it, or name the supported host that reaches it. Otherwise `info`. |
| "The class names look fine." | This lane does not review class names. That is `review-frontend-conventions`. |
| "I could not run the visual tier, so I reasoned it out." | Then it is `info`, marked unverified. Reasoning does not become measurement by being careful. |
| "RTL is handled, the component uses logical properties." | Check the gradients, shadows and transforms too. Those are the ones that do not flip. |

---

## Verification

Report done only once all of these hold:

- Every finding carries a **measurement**: the host width, the element width or
  the offset in pixels, and the command or probe that produced it. An unmeasured
  observation is filed as `info`, marked unverified, and says what would settle it.
- The measurement was taken at the worst real case — the longest translation in
  the catalog, the narrowest supported host, the state where the sibling is
  absent — not at the convenient one.
- Every finding names the `file` of the component that renders the box and `quote`s the code it is about; `line` is derived at ingest from that quote, never counted.
- Every `blocker` and `major` carries `class_scope` with `sites` and an
  `enumeration_method` naming the search that derived the set of elements sharing
  the sizing shape.
- No finding invents a severity: each lands under **Severity (canonical)** in
  `review-orchestrator/SKILL.md`.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, with
  finding ids prefixed `LY-`, or `NEEDS_CONTEXT` naming the context that was
  missing — never a guess in its place.

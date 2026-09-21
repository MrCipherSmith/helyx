---
name: review-flow-graph
model_tier: standard
description: |
  Use when reviewing generic ReactFlow or graph-surface abstraction changes:
  public graph surface, store subclassing, layout lifecycle, internal helper
  boundaries, selection lifecycle, and large-graph performance. Dispatched by
  review-orchestrator for --flow-graph, --project-conventions, --all, or
  src/core/flow/** / graph abstraction changes.
  NOT for: React and MobX component structure outside the graph surface
  (review-frontend), render cost elsewhere in the app (review-performance), or
  the domain rules a graph happens to display (review-logic).
triggers:
  - "flow graph review"
  - "graph ui review"
  - "reactflow review"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
license: "MIT"
---

# Review — Flow Graph Abstractions

Reviewer for reusable ReactFlow/graph integration layers. Use it when a repository has a shared
graph surface consumed by domain modules.

---

## Scope

Applicable to shared graph/flow abstraction folders such as `src/core/flow/**`,
`src/graph/**`, `src/shared/flow/**`, and consumers adding a new graph surface through the
shared public API.

If the repository has local graph docs, read them first and treat this checklist as a neutral
baseline.

---

## Checklist

### Public Surface

- Domain modules consume the documented public graph surface instead of mounting internal shell
  or bridge modules directly.
- New exports are added only when more than one domain consumer needs them.
- Public graph components own common setup such as loader/splitter/viewport wiring/toolbars.

### Store and Lifecycle

- Static viewers and expandable/progressive graphs use the appropriate base store or abstraction.
- Subclasses initialize base state before local observability/reactivity.
- Domain side effects preserve base selection/click/reset behaviour.
- Expand/collapse graphs define fetch and direction/availability contracts explicitly.
- Independent graph data fetches run in parallel and merge through a deduplication helper.

### Internal Boundary

- Layout helpers, shell components, bridge hooks, SVG/canvas geometry helpers, export helpers,
  and popup/container utilities stay internal unless there is a real shared public need.
- New pure node/edge helpers live close to the graph abstraction.
- New visual primitives live in the graph abstraction layer only when domain-neutral.
- Domain-specific data shapes and selection details stay in domain modules.

### Shared Graph Defaults and Performance

- Shared graph defaults are configured in one surface, not repeated per consumer.
- Large nodes/edges arrays avoid deep observation/proxying when shallow/reference observation is
  enough.
- Selection/detail slots use reference semantics when values are swapped as units.
- Lookup maps/indexes are computed once from source arrays for O(1) access.
- Hand graph libraries fresh array references without deep cloning on every render.
- User-initiated graph changes batch writes.
- Animated edge/node effects do not restart unnecessarily on parent rerenders.
- Level-of-detail logic uses discrete thresholds or policy helpers rather than per-frame UI
  rerenders.

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
- **File**: path/to/graph/file.ts:line
- **Problem**: which graph abstraction contract is violated
- **Why it matters**: public surface stability, graph correctness, or performance impact
- **Fix**: concrete change aligned with the shared graph surface
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no rubric of its own; what follows is where its recurring
conditions land under that rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| A graph operation that hangs or exhausts memory at a stated node/edge count | `blocker` | Crash |
| Breaking the public graph surface; bypassing base selection or layout lifecycle | `major` | Named trigger and outcome; a broken contract is not one of the four shapes |
| A performance regression on large graphs, with the size that makes it a cost | `major` | Degradation, not an outage — see `review-performance` for the same boundary |
| Internal helper reaching across a boundary with no observable consequence | `minor` | Correct today; the cost is to the next editor |
| Surface concern with no named caller | `info` | Shared law 1 |

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The domain module imports the internal shell directly, but it renders fine." | Rendering is not the contract. The public graph surface is what the next refactor of the shell is allowed to change; a consumer reaching past it is the break waiting to happen, and it is reportable today. |
| "Only one consumer needs this helper, so exporting it from the graph surface is harmless." | An export is a promise to every future consumer. The rule in the checklist is two consumers, and one is the argument for leaving the helper internal. |
| "This graph felt slow when I read the code." | A performance claim here is a claim about a node and edge count. Name the count at which it degrades, or the finding is `info` under shared law 1. |
| "Deep observation on the nodes array is fine — the library is fast." | The cost is proxying every node on every write, and it scales with the array, not with the library. If you are rating it, state the array size the diff can produce. |
| "The subclass sets up its own reactivity first; base initialisation order is an implementation detail." | The base store's state is what the base selection, click and reset behaviour reads. Initialising after it is the documented lifecycle, not a style preference. |
| "The layout ran, so the lifecycle is intact." | Selection, expand/collapse and reset each have their own lifecycle. A layout that completes says nothing about whether a domain side effect swallowed the base selection reset. |

---

## Verification

Report done only once all of these hold:

- Every finding names `file:line` and the evidence that settles it — the import,
  the export, the subclass member, or the measured count.
- Every `blocker` and `major` carries `class_scope` with `sites` and an
  `enumeration_method` naming the search that produced them — for a surface
  finding, every consumer of the symbol, not only the one in the diff.
- Every performance finding states the node/edge count at which the cost applies;
  without one it is `info`.
- No finding invents a severity: each lands under **Severity (canonical)** in
  `review-orchestrator/SKILL.md`.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, or
  `NEEDS_CONTEXT` naming the context that was missing — never a guess in its place.


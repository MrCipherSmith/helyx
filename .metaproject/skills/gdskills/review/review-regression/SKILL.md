---
name: review-regression
model_tier: deep
description: |
  Use when: reviewing the BLAST RADIUS of a change — the code a change can break,
  as opposed to the change itself. Dispatched by review-orchestrator under scope B
  of a deep round, over the set `keryx review blast-radius` computes.
  NOT for: reviewing the diff (that is scope A and the ordinary reviewers), and
  NOT for style, naming or architecture in code the change did not touch.
triggers:
  - "review regression"
  - "does this change break anything"
  - "blast radius"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review: Regression

You are reviewing **scope B** of a deep round. The files you are given are not
under review. They are under **regression check**.

## The one question

> Does this change break an existing behaviour here?

Not "is this code good". Not "would I have written it this way". The blast-radius
set is code that already worked; your job is to find where the change stops it
working.

This is enforced, not requested. `keryx review ingest` runs
`screenBlastRadiusFindings` over the findings this scope returns and refuses
three shapes outright:

- `outside-set` — anchored to a file that is in neither the computed set nor the
  changed set. A file-less finding survives this only when its `class_scope.sites`
  name something in the set.
- `non-regression-severity` — below `major`. A break in existing behaviour names
  a trigger and an outcome; `minor` and `info` state by definition that it does
  not.
- `no-link-to-change` — nothing in the finding names a changed file, module or
  symbol. A regression claim asserts that THE CHANGE broke this site. **A
  `blocker` is exempt from this rule; a `major` is not.** The rule is a substring
  match over your prose — the only one of the three that can be wrong about a
  true claim — and it may not be the thing that deletes a merge-blocking
  regression. So: when you report a `major` about a **dependent**, name the
  changed file, module or symbol whose behaviour moved. The anchor alone is not
  enough, because every finding the first rule admits is anchored, most of them
  at code the change never touched.

The exemption is not a free pass, it is a recorded one. A `blocker` admitted
without naming the change is listed in `scope.md` under **Admitted without being
judged**, counted next to `accepted:`, and printed on the terminal — so the
record never claims that rule 3 passed on a finding rule 3 never read.

A refused finding does not reach `findings.json`. It is listed by id in the
package's `scope.md` under `## Scope B rejections`, with the rule that refused it
and why, and printed on the terminal by `keryx review ingest` — so a round spent
on them is a round wasted, visibly, and an observation raised under the wrong
scope survives to be filed where it belongs. What the completion gate never sees
is a refused finding, deliberately: it is a claim this round has declined to
make, and the gate blocking on it is the failure this screen exists to remove.

Every rejection RULE judges the CLAIM. None of the three reads the reviewer's
name: a reviewer whose usual question is "is this code good" can still notice a
break, and it is accepted on its merits. What the name decides is **membership**
— which findings the screen judges at all. `review-finding.schema.json` carries
no `scope` property, so the reviewer name is the only surviving record of which
question a finding was dispatched under, and `isBlastRadiusScopedFinding` reads
it to tell scope B's findings from scope A's. Screening scope A by scope B's
rules would reject every legitimate `minor` on a changed file. The distinction is
the whole of it: the name selects the jury, never the verdict.

If the round has no computed blast-radius record to screen against, the ingest is
refused rather than recorded unscreened. The orchestrator supplies it with
`keryx review ingest --blast-radius <file>` — the `--json` output it kept from
Step 3b.

## What you are given

- the diff — what changed;
- the blast-radius set, each entry with its dependency path back to the change,
  computed from the code graph rather than chosen by a model;
- the flow's frozen acceptance criteria;
- the previous round's findings.

The set is bounded by edge distance and a file cap, and **everything the cap
dropped is recorded**. If the record says files were dropped, say so in your
summary rather than implying the set was complete.

## How to look

Start from the dependency path, not from the file. The path tells you *how* the
change reaches this code, and that is the shape of the break: a changed
signature reaching a caller, a narrowed return type reaching a consumer, a
removed branch reaching a case that relied on it, a changed default reaching
something that never passed the argument.

Read the caller before the callee. The break is almost always at the boundary,
and the boundary is where the caller's assumption meets the change's new
behaviour.

## `class_scope` names the caller, not the changed line

When you report, the site a human has to open is the code that **breaks**, not
the code that changed. The changed line is already in the diff and already
reviewed by scope A. Anchor the finding where the damage lands.

## What is not a regression, however true

- The code in the blast radius was already imperfect. Not yours.
- The change makes an existing weakness easier to reach, but the weakness is
  unreachable in this codebase. That is `info` under law 1.
- A test in the set is thin. Say it under scope A if the change touched it;
  otherwise it is not a regression.

## What you cannot see, and must not pretend to

The blast radius is a **code graph**. It does not carry runtime edges: a spawned
process, a file handoff, a string-keyed registry lookup, a hook. It walks
dependents only, so a narrowed contract that breaks something the change
*depends on* is outside your set. And a change to a non-code file — a skill, a
rule, a schema — has an empty radius, recorded as unresolved rather than clean.

If the change is of that shape, say the radius could not answer the question.
That is a useful result. Silence that reads as "nothing found" is not.

## Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

For a regression the sites are the **callers that break**, not the changed line.
A finding anchored to one caller is a claim that exactly one caller breaks —
and a change that breaks one consumer of an interface usually breaks its
siblings. The blast-radius set is already the candidate list: enumerate over it.

```yaml
class_scope:
  sites: ["src/session/store.ts:133", "src/flow/service.ts:412"]
  enumeration_method: "every entry in the blast radius importing the changed symbol; 6 callers, 2 pass the removed argument"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it — though under scope B a finding below `major` is
rejected anyway, so in practice every finding you report carries one.

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what is wrong
- **Why it matters**: impact (data corruption / crash / silent wrong result / spec gap)
- **Fix**: concrete suggestion
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no table of its own.

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

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "This code in the blast radius is badly written, so I will say so." | Scope B asks one question, and it is not that one. The screen rejects it as `outside-set` or as `non-regression-severity`, and the round is spent on a finding nobody reads. |
| "The caller might break." | Might is not a regression. Name the argument that is no longer passed, the type that narrowed, the branch that went away — or file nothing. Below `major` the screen rejects it by construction. |
| "I will anchor the finding at the changed line, since that is the cause." | Scope A already reviewed that line. Anchor where the damage lands: the caller a human has to open is the one that breaks. |
| "The blast radius came back empty, so the change breaks nothing." | An empty radius for a non-code change is recorded as unresolved, not clean. Say the radius could not answer the question — silence that reads as "nothing found" is the failure this lane was built to stop. |
| "It is a `major` about a dependent and the anchor names the file, so the link to the change is obvious." | `no-link-to-change` is a substring match over your prose, and only a `blocker` is exempt from it. Name the changed file, module or symbol in the finding text or it is dropped before it reaches `findings.json`. |
| "The set was capped, but I covered the important ones." | The cap is recorded. If files were dropped, say so in the summary; a report that implies a complete sweep over a truncated set is a false claim about coverage. |
| "The change is only reached through a spawned process / a string-keyed lookup, so the graph must have missed it — I will report it anyway." | Report it, and say the graph could not see the edge. What you must not do is present a runtime path as if the computed set produced it. |

---

## Verification

Report done only once all of these hold:

- Every finding is anchored inside the computed set or the changed set, at the
  code that **breaks** rather than the code that changed.
- Every finding is `major` or above, and every `major` names the changed file,
  module or symbol whose behaviour moved — the anchor alone does not carry it.
- Every finding carries `class_scope` whose `sites` are the callers that break and
  whose `enumeration_method` is the walk over the blast-radius set that produced
  them.
- The summary states whether the cap dropped files, and whether the radius could
  answer the question at all for the shape of this change.
- Nothing that is merely an observation about pre-existing code is filed here; it
  is either raised under scope A or not at all.

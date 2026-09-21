---
name: review-verifier
model_tier: light
description: |
  Use when: consolidated findings from other reviewers need to be checked before they are
  reported — by RUNNING something that fails if the finding is real, or by confirming the
  sites the finding named actually exist. Dispatched by review-orchestrator as Wave C.
  This reviewer can only DELETE. It cannot raise a severity, add a finding, or change a
  finding's text.
  NOT for: first-pass review (run domain reviewers first); re-scoring findings by re-reading
  them, which is the operation this skill replaced and which is measured to degrade accuracy.
triggers:
  - "verify findings"
  - "review --verify"
  - "verification pass"
  - "check these findings"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review — Verifier

Wave C. Reads the findings the domain reviewers produced and tries to **make each
one fail on purpose**. Emits one verdict per finding it checked. It removes; it
never adds and never sharpens.

---

## What this replaced, and why it is not coming back

This slot used to hold `review-strict`: a meta-pass that re-read the consolidated
findings and adjusted their severity, under an elevation table biased 3:1 toward
escalation, **with no new evidence**. It was removed rather than improved,
because the operation it performed is measured to make accuracy worse:

- **GPT-4 on GSM8K across self-correction rounds: 95.5 → 91.5 → 89.0.**
  **GPT-3.5 on CommonSenseQA: 75.8 → 38.1.** Among the answers that changed,
  correct → incorrect exceeded incorrect → correct (Huang et al., *Large Language
  Models Cannot Self-Correct Reasoning Yet*, ICLR 2024, arXiv:2310.01798).
- **Self-Refine (arXiv:2303.17651) shows the same shape from the other side:
  +49.2 on dialogue response generation, +0.2 on maths.** Self-refinement gains
  live on subjective tasks and vanish on verifiable reasoning. Deciding whether a
  null-guard is missing is verifiable reasoning.

So: re-reading a finding and changing what happens to it, without running
anything, is not a rigour pass. It is a coin flip weighted toward more findings.
If you are about to reintroduce it because it looks obviously useful — it looked
obviously useful the first time, and the numbers above are what happened.

## Why this one is different

It does not re-read. It runs something.

- Verification that **executes** rejects **85–96% of false reports**, against
  **4–15% unaided**, while finding **30–44% more true bugs** (AnyPoC,
  arXiv:2604.11950).
- Meta's TestGen-LLM funnel: **75% build → 57% build and pass → 25% improve
  coverage** — and the surviving quarter reaches **73% human acceptance**
  (arXiv:2402.09171). A hard filter that discards three quarters of its own
  output is what makes the remainder trustworthy.
- **80+ agents unanimously endorsed a padding-oracle vulnerability that did not
  exist. A single empirical test killed it.** Consensus cannot detect a
  hallucination its members share, so this skill never votes, never polls other
  reviewers, and never treats agreement as evidence.

---

## Workflow

```
review-verifier Progress:
- [ ] Step 1: Read the consolidated findings (global_id, reviewer, class_scope, evidence)
- [ ] Step 2: Drop every finding raised by yourself — you may not verify those
- [ ] Step 3: For each remaining finding, choose the strongest method that is actually available
- [ ] Step 4: Run it. Record the command and its output verbatim
- [ ] Step 5: Emit one claim per finding checked, conforming to verification-claim.schema.json
- [ ] Step 6: Emit nothing else — no new findings, no severity, no rewrites
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `findings` | array | yes | The consolidated findings, each conforming to `review-finding.schema.json`. `global_id` and `reviewer` must be present. |
| `verifier` | string | yes | Your own name. Recorded on every claim. |
| `branch` / `base_sha` | string | no | So a command can be run against the change under review. |
| `verification_mode` | string | no | `off` \| `annotate` \| `filter`. Informational for you — the mode is applied by the merge, not by you. Default `annotate`. |

---

## Step 3 — choosing a method

Three methods, strongest first. **Take the strongest one that is genuinely
available, not the strongest one you can describe.**

### 1. `execution` — run something that fails if the finding is real

This is the method that works, and in this repository it is nearly always
available: keryx is a Bun project, so `bun test <file>`, `bun run typecheck`, or a
three-line script is cheap and immediate.

The test is not "does the suite pass". It is: **construct the situation the
finding claims is broken, and see whether it breaks.**

```bash
# Finding: "createManagedReviewPackage writes a package even when the contract gate fails"
bun test src/review/managed.test.ts -t "refuses"     # does the guard actually fire?

# Finding: "this guard is asserted against a synthetic value, so it cannot fail"
# Delete the guarded line and re-run. If the test stays green, the finding is CONFIRMED.

# Finding: "the type allows undefined here"
bun run typecheck
```

Record the command and the relevant output. "I ran the tests and they passed" is
not evidence; the command you ran and its output is — `bun test <file>` with
the counts it actually printed, not a count quoted from somewhere else. (This
sentence used to quote a fixed number, which went stale twice in one day.)

A finding is `confirmed` when the procedure **reproduced the defect**, and
`refuted` when the procedure **that would have shown the defect did not**. If the
command you ran would not have failed either way, you have not verified anything —
use `unverifiable` and say what you ran.

#### `refuted` by unreachability is not the end of the thread

There is one refutation shape that closes a finding and leaves a question standing:
the input the finding needs is **unreachable given the current behaviour of a
producer you do not own** — another repository, a service, a generated client.

The harm claim is genuinely dead and `refuted` is the correct verdict. But an
invariant held by another repo's code plus a comment on ours is exactly what breaks
silently when the contract moves, and the question the refutation raises is a
different one:

> *Does any test build the shape that was in question?*

Record that successor question in your **prose summary**, naming the producer and
the SHA your check relied on. It is prose, never a claim — you delete, you do not
add — and the orchestrator picks it up for the next round or routes it to
`review-testing-practices`.

The failure this exists to stop is recorded: a reviewer asked "is this broken?",
a verifier correctly answered "no, the backend never emits that", and the thread
ended. The shape was untested, stayed untested, and the coverage gap was found by a
different reviewer two rounds later. *Is it broken* and *is it pinned* are two
questions; refuting the first says nothing about the second.

### 2. `site-check` — do the named sites exist?

A `blocker` or `major` carries `class_scope.sites`: every location holding the
shape, and how the set was enumerated. Check the list.

```bash
keryx ctx rg "ensureKeryxConfigDir\(" src
```

Weaker than execution, and the reason is worth keeping in mind: this establishes
that the code the finding describes is there. It does not establish that the
behaviour the finding claims occurs. A site list that is right about locations and
wrong about consequences passes this check.

- Sites named, sites found → the finding is about real code. Usually
  `unverifiable` unless the check itself settles the claim.
- Sites named, sites **absent** → `refuted`, and the evidence is the search that
  returned nothing.
- The enumeration is demonstrably incomplete → that is not a refutation. The
  finding is understated, and understatement is not yours to correct. Record
  `confirmed` if you established the shape exists, and say so in the evidence.

### 3. `reasoning` — you could not do either

**Capped at `unverifiable`. It can never be `confirmed`, and it can never be
`refuted`.**

The cap is not conservatism. Reasoning alone produces no new evidence, and a
verdict is a claim about evidence; a "verified" verdict reached by re-reading is
exactly the `review-strict` operation whose numbers are at the top of this file.
`refuted` is capped for the same reason in the other direction: it is the one
verdict that removes a finding, so granting it to the weakest method would
reinstate the removed pass with the sign flipped.

Nothing checkable is lost by this. "The line this finding cites does not exist" is
a `site-check`, not reasoning. `reasoning` is the residual — the cases where you
ran nothing and looked up nothing — and the honest thing for the residual to say
is *I could not verify this*.

The merge enforces the cap: a `reasoning` claim carrying `confirmed` or `refuted`
is rewritten to `unverifiable`, and the attempt is recorded in the review record.

---

## Iron Laws

| Rule | Why |
|------|-----|
| **You can only delete.** No new findings, no severity changes, no edits to a finding's text. | The merge builds the record from the ORIGINAL finding and takes only your verdict. A claim carrying anything else is discarded whole, including its verdict. |
| **Never verify your own finding.** | The reviewer that raised a finding is the one actor whose agreement carries no information about it. Refused by the merge, by name. |
| **Reasoning alone is `unverifiable`.** | See above. Capped in code, not by this instruction. |
| **Every verdict cites what you ran.** | An unevidenced claim is discarded and the finding stays as reported. |
| **Never poll, never vote, never count agreement.** | 80+ agents unanimously endorsed a vulnerability that did not exist. |
| **`unverifiable` is a normal answer.** | Expect it to be the majority. Reaching for `refuted` to look productive is how a true blocker gets deleted. |
| **Not checking a finding removes nothing.** | A finding with no claim is reported unchanged. Absence is not a verdict. |

---

## Output Contract

```
STATUS: DONE | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — every finding you were given was either checked or explicitly left alone.
- `NEEDS_CONTEXT` — you cannot run anything (no working tree, no test command); say what is missing.
- `BLOCKED` — the findings input is unreadable or carries no `global_id`.

There is no `DONE_WITH_CONCERNS`: a verifier has no concerns of its own.

Return one object conforming to
`.metaproject/skills/gdskills/review/review-orchestrator/verification-claim.schema.json`:

````text
```json keryx:verifications
{
  "status": "DONE",
  "verifier": "review-verifier",
  "summary": "12 findings, 4 executed, 3 site-checked, 5 unverifiable",
  "verifications": [
    {
      "finding": "2026-08-29-pr-273#F-001",
      "verdict": "refuted",
      "method": "execution",
      "evidence": "bun test src/lib/config-dir.writers.test.ts -t 'group-writable' -> 3 pass, 0 fail; measured mode 0700 under umask 002, the finding read the wrong call site"
    },
    {
      "finding": "2026-08-29-pr-273#F-004",
      "verdict": "unverifiable",
      "method": "reasoning",
      "evidence": "no command distinguishes the two orderings without a scheduler hook; nothing was run"
    }
  ],
  "stats": { "confirmed": 4, "refuted": 1, "unverifiable": 5, "not_checked": 2 }
}
```
````

Then a short markdown summary:

```markdown
# Verification Report

## Method mix
- execution: N
- site-check: N
- reasoning (capped to unverifiable): N
- not checked: N (with the reason for each)

## Refuted
<[global_id] finding — the command that ran, and what it returned>

## Confirmed
<[global_id] finding — the command that reproduced it>

## Unverifiable
<[global_id] finding — what was attempted and why it settled nothing>
```

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Checking whether a reported finding is real | YES | — |
| Removing a finding an executed check refuted | YES | — |
| Raising a severity, adding a finding, rewriting one | **NO — structurally impossible** | report it as a new round |
| First-pass logic / frontend / backend review | NO | `review-logic`, `review-frontend`, `review-backend` |
| Deciding what became of a finding after the fix | NO | `keryx review complete --disposition` |
| Architectural commentary and opinion | NO | file it as a finding in a domain reviewer, with evidence |

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "I read it carefully and it's clearly correct — `confirmed`." | Reading is not a method. That is capped at `unverifiable`, in code. |
| "It's obviously a false positive, `refuted`." | Obvious to whom, on what evidence? 80+ agents found an obvious vulnerability that did not exist. |
| "The finding is understated; I'll bump it to blocker." | You cannot. The merge discards the whole claim and records the attempt. |
| "Most of my verdicts are `unverifiable`, that looks bad." | It is the expected shape. TestGen-LLM discards 75% of its own output and that is why the remainder is trusted. |
| "I also spotted something the reviewers missed." | Report it through a domain reviewer in a new round, with evidence. This pass cannot add. |
| "I raised this finding, so I know best whether it holds." | That is exactly the case AC9 forbids. |

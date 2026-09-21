---
name: fresh-eyes
model_tier: deep
description: |
  Use when work is still in flight and the person doing it can no longer see what
  is wrong with it — a design half-built, a migration written but never run, a
  patch that feels finished. A reader holding none of the author's reasoning is
  handed two things and nothing else: the artifact, and the contract it must
  satisfy. The author's account of why it works is withheld on purpose, because
  that account is what stops a reader looking. The reader is asked where this
  fails, and answers with doubts anchored to something checkable — or with an
  explicit "nothing found", which is a result rather than a failure to try.
  NOT for: re-testing a finding somebody has already written down, and NOT for
  judging a finished diff against a rubric of things good code has.
triggers:
  - "fresh eyes"
  - "poke holes in this"
  - "am I fooling myself"
  - "too close to this"
  - "tear this apart"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Fresh Eyes

The author of a piece of work cannot un-know why they built it that way. Every
time they re-read it, the reasoning arrives first and the text arrives second,
and the reasoning is what makes the gap invisible — it was already filled in, in
a place the artifact does not contain.

So the doubt has to come from somewhere the reasoning never reached. That is the
whole mechanism, and everything below is about protecting it.

This runs **while the work is in flight** — before it is offered as finished,
while a finding is still cheap to act on and nobody has defended it in public
yet.

---

## 1. What the doubter is given

Exactly two artefacts, and they are handed over without commentary:

1. **The artifact**: the code, the schema, the plan, the migration, the
   document — whatever is claimed to work.
2. **The contract**: what it must do, stated as conditions that are true or
   false. Inputs it must accept, outputs it must produce, invariants it must not
   break, failure modes it must survive, limits it must stay inside. A contract
   nobody can state yet is itself the first finding (§4).

And one question, in the doubter's own words: **where does this fail to meet
that?**

## 2. What is withheld, and why that is not rudeness

Withheld: the author's walkthrough, the commit message, the rationale, "I
already checked X", "that case can't happen", the design doc written after the
design, and the running narration of what the code is *meant* to do.

The reason is not distrust; it is that an explanation is a **route through the
artifact**. Given one, a reader follows it — checking the path the author
already checked, in the order the author already checked it, and arriving where
the author already arrived. The paths nobody walked stay unwalked. That is the
same reader, doing less work, returning agreement.

Two consequences the author has to accept:

- The doubter will re-derive things the author already knows, and will sometimes
  ask a question the author answered last week. That cost is the price of the
  one question they did not answer.
- Anything the doubter genuinely cannot proceed without — how to run the thing,
  where the data comes from, which of two branches is live — is **procedure**,
  and is supplied. The line is: how to operate it, yes; why it is right, no.

If the artifact is only correct once it is explained, the explanation belongs in
the artifact. Discovering that is itself a finding.

## 3. The bar for raising a doubt

An unbounded sceptic is not free. Every doubt raised costs the author a context
switch, and a stream of preferences trains them to skim the stream — which is
how the one real defect in it gets skimmed too.

A doubt qualifies when **all four** hold:

| It must | Meaning |
|---|---|
| Name a concrete failure | An input, a state, a sequence, or a value for which the stated contract is not met. Not a shape you distrust. |
| Be anchored | A file and a line, a step in the plan, a field in the schema — something the author can open. |
| Be checkable | You can say what observation would settle it: a command, a query, a case to run, a value to print. |
| Survive one honest re-read | Look again at the artifact for the thing that already handles it. Most first doubts die here, and that is the filter working. |

What does **not** qualify, at any volume: this would be cleaner another way; I
would have used a different structure; this style is unusual here; this feels
fragile; there might be an edge case. "Might be an edge case" becomes a finding
only when you name the case.

**Rank what survives.** Report what breaks the contract first, what breaks it
only under a condition you can name second, and unanchored unease last or not at
all. If everything you have is in the third group, the honest report is §5's
empty one.

## 4. When nothing can be checked at all

Sometimes the artifact cannot be brought into a state where any observation is
possible: it does not build, the fixture is missing, the contract is three
contradictory sentences, half the work is in an uncommitted buffer.

Do not substitute reading for running. A careful read of code you could not
execute yields opinions with the confidence of tests, which is the worst output
this skill can produce.

Instead, in this order:

1. **Try the cheap repairs yourself** — install, generate, seed, stub the one
   missing collaborator — and **write down what you had to do**. The list of
   repairs is a finding about the artifact's reproducibility.
2. **Ask only procedural questions** (§2) and give them a deadline in the work,
   not in the day: if the answer does not arrive, report without it.
3. **If the contract is what is missing**, stop and say so. "I cannot tell
   whether this is wrong, because nothing states what it must do" is the highest
   severity result in this skill. Everything else is downstream of it.
4. **Report the blockage as the result.** Name what could not be reached, what
   was tried, and what would unblock it. A blocked cycle is finished work with an
   empty finding list — not a cycle to re-run with more determination.

## 5. How a cycle ends

This is a doubt loop, and a loop with no bound is how a day is spent producing
increasingly speculative objections to work that was fine after round two.

Fix the bound **before the first round**: a number of rounds, usually one or
two, agreed with whoever asked. Then a cycle ends at the first of these:

- **A round raises no new doubt that clears §3's bar.** Not "no doubt" — no
  *new* one. Re-raising a finding already reported is not a round.
- **The agreed round count is spent**, whatever remains unexamined. Say what was
  not looked at.
- **A finding invalidates the contract itself**, per §4.3. Doubting against a
  contract now known to be wrong produces nothing; the author answers first.
- **The artifact changes underneath you.** A rewritten artifact is a new cycle
  with a new bound, not a continuation of this one.

A cycle that ends with no findings is a **completed cycle**. Say what you
checked and what you could not reach, and stop. Manufacturing a finding to
justify the round is the single most expensive thing this skill can do: it
spends the author's attention and it teaches them that this report is noise.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The author explained the design first, so I understood it faster." | You did, and that is the loss. Their explanation routed you down the path they already checked; the unexamined path is the one the defect is on. Being handed the reasoning turns a second reader into a slower copy of the first. |
| "I could not run it, so I read it extremely carefully instead." | Careful reading of code you never executed produces opinions wearing the confidence of tests. Repair the environment, or report the blockage as the result — do not upgrade a hunch because the check was unavailable. |
| "Three rounds and nothing, so there must be something subtle left." | The loop has no natural end, so it invents one. Absence of findings after a bounded, recorded search is the result. "There must be something" is a belief about work, not an observation of it. |
| "This would be cleaner with a different structure." | That is a preference, and it costs the author the same context switch a real defect does. Name the input for which the current structure fails the contract, or drop it and spend the attention on something that breaks. |
| "The author says that case cannot happen, so I moved on." | Then it is an invariant, and an invariant is checkable. Ask what enforces it and look at that. "Cannot happen" held in someone's head is the most common place for a live defect to be filed. |
| "Nothing broke the contract, so I listed the smells I noticed." | An empty finding list is a legitimate completed cycle; padding it is how a report becomes something the author learns to skim. The next report — the one with a real defect in it — gets skimmed the same way. |
| "The contract was vague, so I reviewed against what it obviously meant." | Now there are two contracts and the author never saw yours. Every finding against an invented contract is arguable, so all of them get argued. Stop and get the real one written down. |
| "I fixed the problem while I was in there." | Doubting and repairing in the same pass destroys the asymmetry: you now hold the reasoning for the repair and cannot doubt it. Report it; let it be changed by the person who owns it. |
| "It is basically done, so this can wait until review." | In flight is when a finding costs an edit. After it is offered as finished, the same finding costs a defence, a negotiation and a rework — and the author has by then said out loud that it works. |

## Verification

A cycle is complete only when all of these hold:

- The contract was stated before the doubting started, as conditions that can be
  true or false, and it came from the requester rather than from your reading of
  the artifact.
- The author's rationale was not read. If something procedural had to be asked,
  the report says what was asked and why it was procedure and not rationale.
- The round bound was fixed before round one, and the report says which of §5's
  four endings actually stopped the cycle.
- Every reported doubt names a concrete failure, an anchor, and the observation
  that settles it. Preferences are absent, not merely marked as minor.
- Doubts that died on re-read are not reported, and the report does not say how
  many there were.
- If nothing could be checked, the report carries what was tried, what blocked
  it, and what would unblock it — and claims no findings.
- If the cycle found nothing, it says so plainly, with what was checked and what
  was left unreached. `STATUS: NO FINDINGS` is a pass, not an incomplete run.

Credit: [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
(MIT) is where the in-flight doubt pass comes from: a reader gets the artifact
and the contract, never the author's reasoning. The bar and the bound are ours.

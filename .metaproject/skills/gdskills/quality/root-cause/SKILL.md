---
name: root-cause
model_tier: deep
description: |
  Use when a defect exists and nobody can yet say what produces it — a crash, a
  wrong result, a failure a user hits and the suite never sees. The order is
  fixed: reproduce it and write down how, localize before editing anything,
  reduce to the smallest failing case, repair the mechanism rather than the
  symptom, and leave behind a guard that was WATCHED failing without the repair.
  Covers the case the defect refuses to appear: which evidence is admissible,
  when to stop looking, and what to report in place of a fix.
  NOT for: a defect already pinned to a line and a mechanism, where nothing
  remains but writing the patch and its guard.
triggers:
  - "root cause"
  - "why does this fail"
  - "cannot reproduce"
  - "track down the bug"
  - "debugging"
  - "bisect"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Root Cause

A defect exists and nobody knows why. Your job is **not** to make the symptom
stop. It is to name the mechanism that produces it, change that, and leave
something behind that fails if it ever comes back.

The five steps below are an order, not a menu. Every one of them is skipped by
agents in the same way — forward, into the edit — and each skip costs the step
after it.

## 1. Reproduce, and write the reproduction down

Before any code is read: the exact command, the input, the environment, what you
expected, what happened, and **how often** — `10/10` and `3/10` are different
defects with different causes.

A fix produced without a reproduction is a guess with a diff attached. It cannot
be verified, because there is nothing that was failing to stop failing.

If the reproduction needs setup (a seeded row, a cleared cache, a second
process), that setup is part of it. Write it as commands someone else can run.

## 2. Localize before you edit

Reading a file top to bottom is not localization; it is hoping. Localization is
a **search that halves**:

- over history — `git bisect` between a known-good and known-bad revision;
- over the call path — `keryx gdgraph affected <file>` for what reaches the
  site, then a probe at the midpoint of the path;
- over the input — cut the payload in half, keep the failing half;
- over the environment — one variable, one flag, one version at a time.

Two rules hold for the whole step. **Change one thing and record what happened.**
And **an edit made "to see what happens" is not a fix** — it either goes away or
it gets named in the diff as instrumentation.

Long output (a bisect run, a failing suite, a log) goes through
`keryx ctx run -- <cmd>` rather than into the reading window whole.

## 3. Reduce to the smallest failing case

Delete everything that can be deleted while it still fails. Each removal that
keeps the failure is evidence about what does **not** matter, and the residue is
usually the cause stated in the shortest possible form.

A reduced case is also the guard from step 5, already written.

## 4. Name the cause, then repair it

Say it in one sentence carrying a **mechanism**, not a location: "the cache key
omits the tenant id, so the second tenant reads the first tenant's row". "It is
in `store.ts`" is a location. "It is a race" is a category. Neither is a cause.

Then check the repair against that sentence:

| The repair | What it actually is |
|---|---|
| A guard that returns early when the value is missing | The missing value is the defect; you hid the only thing reporting it |
| A retry, a longer timeout, a `sleep` | The mechanism is untouched and now it is slower and intermittent |
| A widened type, a cast, an `any` | The compiler was right; the wrong value is still produced |
| A changed assertion or an expectation loosened to match | The test was the last thing telling the truth here |

Every row above makes the symptom go away. None of them is this skill's output.

## 5. Leave a guard that was seen failing

A test written after a fix and never observed red proves the test runs. It does
not prove it catches anything.

So: run the new test against the **unfixed** code and watch it fail. If the fix
is already applied, undo it in place (never `git stash` — a scoped stash takes
other people's uncommitted work with it), watch the test fail, restore the fix,
watch it pass. Record both observations.

If the defect cannot be reached from a test — it needs a device, a customer's
data, real concurrency — say so, and say what the guard would be instead: an
assertion, a counter, a log line at the decision point.

---

## When it does not reproduce

This is the case handled worst, and it is handled worst in one specific way: the
search for the defect quietly becomes a search for *something wrong*, and a
plausible-looking repair is shipped for a failure nobody ever saw.

### What is admissible

In descending strength:

1. **A failure you produced yourself.** Nothing else is in this class.
2. **An artifact of the original failure** — a stack trace, a log line with a
   timestamp, a CI run id, an error string quoted by the reporter, a dump.
3. **A path you can show reaches the reported state**, with the input that
   drives it *named and shown to exist*.
4. **A measured environment delta** — a version, a locale, a timezone, a clock
   skew, an ordering, a concurrency level you actually varied and observed.

Not admissible, at any strength: this looks wrong; this pattern is usually a
bug; this is the kind of thing that causes that; two readings of the same file
agreeing. Reading harder produces no new evidence — the file says the same thing
the third time.

### Widen the attempt before you give up

One axis at a time, each attempt and its result recorded: input, environment and
versions, ordering and concurrency, persisted state (cache, DB, temp files),
clock and timezone, isolation (the single test vs the whole suite), random seed.

For anything intermittent, a count replaces a verdict. Run it 50 times and
report `1/50`. "It passed when I re-ran it" is not a result.

### When to stop

Stop when any of these is true, and stop deliberately rather than by drifting
into a fix:

- the next axis is one you cannot control — production data, a customer's
  machine, hardware you do not have;
- the budget the task set for reproduction is spent;
- going further requires changing the code under investigation to see anything
  at all. That is instrumentation, and landing it is a separate decision the
  requester gets to make.

### Report instead of a fix

Not reproducing is a result, and it is reportable. What it is not is permission
to ship a change. The report carries:

- every reproduction attempt, one line each, with what happened;
- the strongest evidence held, labelled with its class from the list above;
- the hypotheses that survive that evidence — two or three, each with **the
  observation that would kill it**;
- the instrumentation that would settle it, and where it goes;
- what was left unchanged.

Landing instrumentation alone and stopping is legitimate work. Landing a
speculative repair and closing the issue is not: if no experiment can tell your
change from a no-op, nothing was fixed, and the next person's bisect now
straddles a commit that did nothing.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "It never reproduced, but I found something that looks wrong — I will fix that." | A smell you found and a defect you never saw are different objects. Repairing the smell closes the ticket with the reported failure still live, and the next report now arrives against code you changed for unrelated reasons. |
| "It passed when I ran it again, so it is flaky / it is gone." | A single pass is not evidence of absence for a failure that was observed. Run it 50 times and report the rate; `1/50` is a finding, "it passed" is a sentence about one run. |
| "The stack trace names this line, so this line is the cause." | The trace names where the bad value surfaced, not where it was produced. The throwing frame is usually innocent; walk back to where the value was created and prove it was already wrong there. |
| "A null check here makes the crash go away." | The crash was the only thing reporting that the value was missing. A guard moves the failure somewhere later, quieter, and further from its cause — and the next report will not mention this file. |
| "I fixed it and the test I added passes." | A guard never watched failing proves the test executes. Run it against the unfixed code first; if it passes there, it is testing something other than the defect. |
| "I changed three things and now it works." | You have a working tree and no cause. One of the three was the fix and two are unexplained edits nobody can review. Revert to one change at a time, or the repair is folklore. |
| "It only breaks in CI, so it is an infrastructure problem." | "Only in CI" is an environment difference you have not named yet — ordering, concurrency, a clock, a locale, a missing file, a cold cache. Name the difference before assigning the defect to somebody else. |
| "It is obviously a race condition." | "Race" is a category, not a cause. Which two operations, over which piece of state, in which interleaving? Without those three, the word ends the investigation instead of advancing it. |
| "The reproduction takes too long to write down; I have it in my head." | The reproduction is the artifact the fix is verified against. Unwritten, it cannot be re-run after the change, and "it works now" becomes unfalsifiable. |

## Verification

Report the defect fixed only when all of these hold:

- The reproduction is written down as commands plus expected/observed, and it
  failed before the change.
- The cause is one sentence naming a mechanism, not a file and not a category.
- The change alters that mechanism. No symptom was suppressed by a guard, a
  retry, a widened type, or a loosened assertion.
- A guard exists and was **watched failing** against the unfixed code; the
  report says where that was observed.
- Everything added to investigate — logging, timeouts, skipped tests, scratch
  edits — is either removed or deliberately kept and named in the diff.
- If it never reproduced, no fix is claimed: the report carries the attempts,
  the evidence and its class, the surviving hypotheses with their killing
  observations, and the instrumentation that would settle it.

Credit: [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
(MIT) is why this set carries a debugging skill at all; the step order, the
evidence classes and the non-reproduction protocol were written here, not taken.

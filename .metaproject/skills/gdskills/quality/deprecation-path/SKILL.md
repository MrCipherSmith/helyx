---
name: deprecation-path
model_tier: deep
description: |
  Use when a spelling this project already published has to leave — a CLI flag,
  a command name, a config key, an exported symbol, a field in a
  machine-readable payload — and callers nobody can enumerate are still passing
  it. Deleting it raises nothing: the caller who sends the old spelling gets a
  run that looks successful and does none of what was asked. Orders the work —
  the replacement lands first, the old spelling keeps reaching the same single
  implementation, one notice per invocation names its replacement and when the
  old spelling stops, the project's own generated output and prose stop
  teaching the old name, and only then is it refused by name with the reason.
  Covers how to find dependants you cannot see, and what the change owes
  whoever cannot migrate yet.
  NOT for: moving a project onto newer releases of packages somebody else
  publishes, and NOT for reshaping data already stored in a database.
triggers:
  - "deprecate this flag"
  - "retire the old command name"
  - "we need to remove a config key people still set"
  - "sunset this option without breaking callers"
  - "plan the deprecation"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Deprecation Path

A published name is not yours any more. The moment somebody's CI runs it, a
colleague pastes it into a runbook, or your own installer writes it into a
generated config, the spelling is a contract — and the thing that makes
retiring it dangerous is not that removal breaks callers loudly. It is that
removal usually breaks them quietly.

An argument nobody recognises is, in most surfaces, ignored. The flag is
dropped, the config key is skipped, the field comes back `undefined`. The
command exits 0. The caller reads success, the operator reads success, and the
work the flag asked for silently stopped happening. `rejectUnknownFlags` says
it in one line — *"a flag that is silently dropped writes nothing and reports
success"* (`src/commands/review.ts:307-318`).

`rules/core/cli-interface-design.mdc` sets the standard a surface must meet.
This skill is the work of getting an existing spelling from where it is to
gone, in an order that never puts a caller in the dark.

---

## 1. The sequence

Five stages. They are ordered because each one makes the next safe, and the
common failure is running stage 5 in the release that first shipped stage 1.

1. **The replacement ships and works.** A caller cannot migrate to something
   that is not released. Until a published version carries both spellings, no
   notice is actionable and no clock has started.
2. **The old spelling keeps working, through the same implementation.** Not a
   copy — the alias shape, and the shipped example of it, are §5 of the rule.
3. **One notice, naming the replacement.** See §3. It goes on stderr, and it
   fires once per invocation.
4. **Your own tree stops emitting and teaching the old name.** See §4. This is
   the stage that gets skipped, and skipping it is why nothing ever reaches
   stage 5.
5. **Removal — refused by name, with the reason.** See §5.

Between 3 and 5 sits real calendar time, and the thing that ends it is not the
date: it is stage 4 being true, plus whatever evidence §2 can actually get you.

## 2. Who depends on it, when you cannot see the callers

For an internal symbol, the answer is mechanical — find the references, change
them, done. That is not a deprecation; it is a rename. The skill starts where
the reference list is incomplete by construction.

Look where you *can*:

- **Your own tree first, and all of it.** Not just the source: generated
  output, templates, installer messages, docs, config files. The MCP rename
  left eleven occurrences in `src/` alone, *"including the template that
  generates `.metaproject/modules/mcp.md`, and the message `init.ts` prints to
  every new project telling it to run the retired spelling"* — read off the
  build gate that finally caught them (`check-retired-cli-spellings.ts:46-50`).
  Your own tree is the dependant you are most likely to miss, and the only one
  you can fix yourself.
- **The artefacts you have written into other people's machines.** An installer
  that wrote a command into an editor config has already created dependants,
  and they are enumerable.
- **Anything that pins the shape.** A contract test, a schema, a pinned
  `schemaVersion` — each one is a reader whose expectations are written down.

Then accept the part you cannot see. Scripts, CI jobs, and other people's
tooling leave no trace in your repository, and *"unused" means "no usage you
can see"*. When you cannot tell, the answer is not to guess a number — it is to
pick the path that is safe under the worst case: alias with a notice, and let
the notice itself be the measurement.

That phrase is only a mechanism if you say what it measures, and the honest
answer is: one direction, weakly. A stderr line reaches whoever is watching a
terminal. The callers you are actually worried about — a nightly job, a build
step, somebody's wrapper script — are the ones nobody is watching, and they
will run your deprecated spelling, print your notice into a log nobody reads,
and succeed. A complaint arriving is evidence the surface has live callers; no
complaint arriving is evidence of nothing, and reading it as "nobody uses
this" is the same mistake as reading an empty grep that way. What ends the
wait is stage 4 being true in your own tree, plus the named end §6 owes the
caller. An absence of complaints is never permission to skip to stage 5.

One thing you must decide explicitly: **is continuing to honour the old
spelling acceptable at all?** Usually yes. Sometimes the old behaviour is the
defect. `allowAutoAccept` in `.metaproject/memory.config.json` is deprecated
*and ignored* — the key is stripped and a warning names it, because honouring
it would auto-accept memory entries that must stay draft-only
(`src/memory/config.ts:56-60`). That is a different path, and it has to be
declared as one: the caller is not being asked to migrate, they are being told
their setting stopped applying.

## 3. What the notice has to carry

A notice that says "deprecated" and stops is a line a reader dismisses. Three
things make it actionable, and all three fit in one sentence:

- **What replaced it**, spelled exactly as it must be typed.
- **How to migrate** — for a like-for-like rename that is the new spelling
  itself; for anything else, the shape the caller now writes.
- **When the old spelling stops working.** Three answers are legal, and picking
  between them is the decision — not filling the slot. A named version or date.
  What is true *now*, where the old behaviour has already stopped: the memory
  config line does all of it — *"is deprecated and ignored; ingest and
  reflection remain draft-only. Remove it from memory.config.json."* Or, in
  those words, that **no removal is scheduled**. That third answer is the
  shipped one here: `announceRename` prints *"<retired> is deprecated — use
  <replacement> instead."* and stops (`src/commands/mcp.ts:90-92`), and those
  retired verbs still work today. An end date is what §6 owes a caller who
  cannot move yet; it is not what makes a notice actionable. What is never legal
  is leaving the reader unable to tell "not scheduled" from "nobody said" —
  and inventing a version to avoid that is worse than admitting there is none.

Where the notice goes, how often it fires, and the contract test that pins both
are §5 of the rule, with its worked example and the reasoning behind each. Read
it there rather than re-deriving it here.

The counter-example is the rule's too: an alias nobody is told about is a
permanent surface — all the maintenance cost of a deprecation, none of the
progress, and nothing that will ever justify retiring it.

## 4. Stop teaching the old name

The retired spelling still works, which is exactly why prose drifts back to it:
*"nothing breaks, so nothing complains, and the documentation slowly re-teaches
the name the rename was meant to retire"*
(`check-retired-cli-spellings.ts:8-11`). That gate fails the build when a
reader-facing surface instructs anyone to run a retired spelling, over
README, docs, the metaproject tree, `src/**/*.ts` and even `.gitignore` — two
declared exemptions: a was→is row, recognised **by shape** so a new document
recording the history needs no allowlist entry, and an in-band
`retired-spellings-ok: <scope> — <reason>` marker. *"An exemption that cannot be
read is not an exemption"* (`:31-32`).

The sharper half of the same stage is output you generate for other people.
`MCP_SERVER_ARGS` is deliberately the new spelling, because a config written by
the installer with the old one would mean *"shipping our own deprecation
warning into other people's tools, permanently"* (`src/mcp/client-config.ts:33-37`).
The rule generalises: **never emit a spelling you are asking others to stop
using.** Your generated artefacts are dependants you control, and they must
migrate first.

## 5. The removal itself

Removal is not deletion. The spelling stays in the code, doing one job: saying
it is gone and why.

- **Refuse by name, with the reason** — never as a generic unknown option, so
  anyone who scripted it learns why it is gone instead of reading it as a typo.
  The pattern and its shipped example are §5 of the rule.
- **A removed field moves the version.** Dropping one boolean from the skills
  export manifest moved `schemaVersion`, because *"a reader that still expects
  the boolean sees `schemaVersion: 2` and knows why it is absent instead of
  reading `undefined` as `false`"* (`src/gdskills/export.ts:167-193`).
- **A retired FILE needs identity, not a name.** `RETIRED_RULES`
  (`src/gdskills/retired-rules.ts`) records the sha256 of *every* content
  version a retired rule ever shipped, and `removeUnmodifiedRetiredRules`
  deletes an installed copy only on a hash match — because a file at that name
  the project edited is the project's own, and *"deleting someone's edited
  content without asking is not a call an installer gets to make"*. Every
  version, not only the last: a project sitting on an older copy still holds an
  untouched leftover.
- **Do not let an alias stand in for two things.** The health payload's
  `regressions` is a deprecated alias, and the renderer prints both real
  counters beside it *"rather than letting the alias stand in for both"*
  (`src/harness/tool/metaproject-operations.ts:579-582`). An alias that
  conflates is worse than one that is merely old.

## 6. What the migration owes whoever cannot move yet

Some caller cannot migrate on your schedule: they are pinned, they are
downstream of you, they are a team with a freeze. The change owes them four
things, and none of them is an indefinite extension.

1. **A named end**, not "eventually". A date or a version. An open-ended
   deprecation is a permanent surface with a warning attached, and everyone
   learns to skip the warning.
2. **A migration they can perform without you** — the exact replacement
   spelling, and, where the shape changed rather than the name, the before and
   after. If the migration needs a decision only you can make, the deprecation
   is not ready to be announced.
3. **The old behaviour unchanged while it lasts.** An alias that has quietly
   started behaving differently is a breakage with a warning label on it. The
   alias calls the same implementation; that is what makes the promise cheap.
4. **A way to say they are stuck that reaches you.** The notice names the
   replacement; the release notes name the removal version. A caller who
   discovers both at once, on the release that removed it, was never given a
   path.

When you cannot give them (1) — because the old behaviour is unsafe, not merely
old — say that instead of pretending there is a schedule. "This stopped
applying, here is what is true now" is a fair thing to tell someone. "This will
go away sometime" is not.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "Nothing in the repo calls it any more, so removing it is safe." | You searched the tree you can see, which is where §2 starts, not where it ends. The cost of being wrong is a silent failure in somebody else's pipeline — which is why the rule's own non-negotiable is that a published spelling is never deleted, only aliased or refused by name. |
| "The replacement is in, so I'll drop the old spelling in the same release." | Then the release that teaches the new name is the release that breaks the caller, and they learn both facts from the same incident. A caller cannot migrate to something not yet published — the clock starts only once a shipped version carries both. |
| "I'll keep the old flag working and skip the notice — nobody gets hurt." | `keryx review` has accepted `--target-ref` silently, with no notice and no help entry, for exactly that reason. Nothing ever tells a caller to migrate, so nothing will ever justify retiring it. A silent alias is permanent maintenance bought with zero progress. |
| "The alias can re-implement the old behaviour, it's only a few lines." | That is two implementations free to drift, and the one nobody runs is the one that rots. The retired publisher verbs translate the argument shape and call the new command — one implementation, nothing to drift — which is why a contract test can assert the old path still writes the same files. |
| "I'll print the warning everywhere the old path is touched, so it can't be missed." | A run that performs three writes then prints three identical lines, and a line a reader sees three times in one command is a line they learn to skip. One notice, once per invocation, printed beside the routing decision and never inside the loop. |
| "It says deprecated, that's the notice done." | "Deprecated" is a label, not an instruction. What replaced it, how to spell the replacement, and when the old one stops — three facts, one sentence, or the reader has nothing to act on and dismisses the line. |
| "Our own docs still use the old name, we'll clean them up as we go." | Eleven occurrences survived one rename in source alone, including the template that generates a module document and the message printed to every newly initialised project. The spelling still works, so nothing complains, and the tree quietly re-teaches the name you are retiring. |
| "Removing the field from the JSON is fine — readers will just adapt." | A reader that still expects it cannot tell removal from a false value, and reads `undefined` as `false`. The version moves in the same commit as the removal, so absence is legible instead of being silently the wrong answer. |
| "They can't migrate yet, so we'll hold the removal open indefinitely." | An indefinite hold is a permanent surface with a warning attached, and warnings nobody ever sees expire become decoration. Name the version. If the real reason is that the old behaviour is unsafe rather than merely old, stop the behaviour and say so — that is a different path, not a longer one. |

## Verification

Do not report the work as done until all of these hold:

- A published version carries the replacement **and** the old spelling, and the
  old spelling reaches the same implementation rather than a second copy of the
  behaviour.
- A test asserts the old spelling still works, still produces the same effect,
  and names the replacement exactly once.
- The notice is on stderr, fires once per invocation, and states the
  replacement, the migration, and one of §3's three answers to *when*: a named
  version or date, "no removal is scheduled" in those words, or — where the old
  behaviour is not being honoured at all — what is true now instead. A version
  nobody has committed to does not satisfy this; a caller plans against it, so
  an invented date is a worse answer than none.
- Every occurrence of the old spelling in your own tree is gone or declared:
  generated output, installer messages, templates, documentation, config files.
  Nothing you emit for somebody else teaches the name you are retiring.
- The search for dependants is written down — where you looked, what you found,
  and the population you could not see — rather than replaced by an assertion
  that nobody uses it.
- The removal, when it comes, refuses by name with the reason; a removed or
  renamed field in a machine-readable payload moves its `schemaVersion` in the
  same change; a retired shipped file is identified by content hash, across
  every version ever shipped, not by its name alone.
- The end is either named as a version or a date, or declared not yet scheduled
  — a guess dressed as a schedule is neither — and the caller has the
  before-and-after to migrate unaided, under behaviour unchanged under them.

Credit: [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
(MIT) is why this set carries a deprecation skill at all; the five stages and
the notice rule were measured from keryx's own CLI, not taken from there.

---
name: api-truth
model_tier: deep
description: |
  Use when code is about to call a dependency nobody has read today — a client
  method, an option object, a config key, a CLI flag — and the only thing
  vouching for the signature is somebody's recollection of it. Recollection has
  a cutoff date; the version resolved in this project does not. Settles what
  "checked" means: the version actually installed here rather than the newest
  one, the artefacts that carry it in rank order, and which side wins when the
  published documentation and the installed build disagree. Every call that went
  out unchecked is MARKED as unchecked, so a later reader can tell a verified
  signature from a remembered one.
  NOT for: moving a project onto newer releases of the packages it already has,
  and NOT for picking which library or architectural pattern to adopt before
  anything is installed.
triggers:
  - "check this against the installed version"
  - "is that still the API"
  - "did you make that signature up"
  - "which version do we actually have"
  - "look up the real API"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# API Truth

A remembered API call is a claim about a version. The claim is usually right,
which is the problem: it fails quietly, in the small fraction of cases where the
library moved, and it fails in the worst possible way — the code compiles, the
option object accepts the unknown key and ignores it, and nothing surfaces until
production or never.

Model weights have a cutoff date. A dependency does not. The gap between them
grows every day the project is alive, and no signal inside the editor announces
it.

This skill is not "look things up". Looking things up on every call is a rule
agents follow twice and abandon. It is four decisions: **when** the check is
worth its cost, **which version** counts as the truth, **what** counts as a
source, and **how** the unchecked calls are marked so somebody downstream can
see them.

---

## 1. The version is the one installed here, not the latest

"I checked the docs" means nothing until it names a version. The default failure
is checking the current documentation of a library this project pinned eighteen
months ago — same defect as recollection, with a citation attached.

Three different numbers exist, and only one of them runs:

| Number | Where | What it is |
|---|---|---|
| The range | `package.json` / `pyproject.toml` / `go.mod` | What the project will *accept*. Not a version. |
| The resolved version | `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `Cargo.lock`, `go.sum` | What a fresh install produces. |
| The installed version | `node_modules/<pkg>/package.json` → `"version"`; `pip show <pkg>`; `cargo tree -p <pkg>` | What is on disk and executing **now**. |

Read the third. When the third and the second disagree, the tree is stale and
that is itself worth reporting — a call verified against a stale tree is
verified against nothing anyone else has.

For a transitive dependency, the version your direct dependency pulls is often
not the version at the top level. Resolve the one on the actual path.

## 2. When the check is worth paying for

A skill that says *always verify everything* is ignored by the third task. The
cost is real, so spend it where the failure is silent.

**Check before writing the call when any of these hold:**

- The symbol is not visible in types you can see — an untyped package, a config
  object typed `Record<string, unknown>`, a CLI flag, an HTTP endpoint, a
  template convention. Nothing will catch you.
- The option is a **key in a bag**. Unknown keys in option objects, YAML, and
  env-var maps are ignored in silence; a typo and a removed option are
  indistinguishable from working code.
- The call has an effect you cannot see locally — a write, a payment, an auth
  decision, a migration, a cache invalidation, a webhook.
- You know a major version boundary sits between your recollection and the
  installed number, or you cannot say which side of one you are on.
- Defaults matter to the behaviour you promised. Defaults change in *minor*
  releases more often than signatures do, and no compiler mentions it.

**Do not pay for it when:**

- The call is typed and the type-checker runs on it. A strict `tsc --noEmit`
  against the package's own shipped `.d.ts` **is** a check against the installed
  version, performed by a machine, for free — that is §3's rank 1 already done.
- A test you watched fail and then pass exercises this exact call path.
- You read this same symbol, at this same version, earlier in this session.
  Record it once; do not re-fetch per call site.
- It is the language or runtime standard library at a version the toolchain
  already pins.

Everything outside both lists is a judgement call, and the tiebreaker is: how
long would this defect stay invisible? Loud and immediate — write it and let the
failure teach you. Silent — check first.

## 3. What counts as a source, in rank order

1. **The installed artefact itself** — the `.d.ts` beside the package, the
   `node_modules` source, `inspect.signature`, the binary's `--help`. It cannot
   be at the wrong version, because it *is* the version. Highest rank, and
   usually the fastest to reach.
2. **The package's own documentation, pinned to the installed version** — the
   docs for the exact version installed, reached by whichever of these the
   environment actually has. None of them ships with this skill or is installed
   for you; check what is there before you reach for one:

   - A versioned docs URL, or the repository at the tag matching that version.
   - A docs-retrieval tool, where one is configured — a `ctx7`-style MCP server,
     or `npx ctx7@latest library "Library Name" "<the actual question>"` then
     `npx ctx7@latest docs /org/project/<installed-version> "<the question>"` if
     that CLI is reachable. Official spelling ("Next.js", not "nextjs"), the real
     question rather than one word, three commands of budget, no credentials.
   - With neither, the docs shipped *inside* the installed artefact — its README,
     its `docs/`, the binary's long help — pinned by construction. If that is
     empty too, rank 2 is unavailable here: say so and rely on rank 1.
3. **The package's own documentation, unpinned** — acceptable only after you
   state the gap between it and the installed version, and treat everything it
   says as provisional across that gap.
4. **The changelog or migration guide**, for the narrow question of *what
   changed between two versions you have named*. Not for what the API is now.
5. **A blog post, a forum answer, another project's code, and your own
   recollection** — all the same rank, which is *hypothesis*. They are worth
   something: they tell you what to go and look at in ranks 1–3. They are worth
   nothing as evidence, and a citation of one is not a check.

## 4. When the documentation and the installed build disagree

This is common, and it is the point where a careless agent picks the wrong side.

**The installed artefact wins.** Documentation describes a version, usually the
newest; `node_modules` is what executes. If the docs show an option the types do
not have, the option does not exist here.

The disagreement is not noise to route around — it is a finding, and it has to
be named before you carry on:

- Say which version the docs were at and which is installed. Nine times out of
  ten the gap explains the disagreement, and now the next person does not
  re-derive it.
- Same version, still disagreeing? Then the docs are wrong, or you are reading a
  different export path, or a patch/override is rewriting the package. Check the
  path before concluding the docs are wrong.
- Never split the difference by writing the documented call and adding a
  fallback for the installed one. Two paths, one of which has never run, is a
  larger defect than the one you were avoiding.
- If the behaviour you need exists only in the documented version, that is an
  upgrade decision and it belongs to whoever owns the dependency — say so, and
  do not smuggle the bump in beside the feature.

## 5. Marking what was not verified

This is the part that survives into review, and the part agents skip.

A checked call and a remembered call look identical in a diff. Unless the
difference is written down, the reviewer inherits a file where every line
carries the same implied confidence, and the one guess is camouflaged by forty
facts around it.

At the call site, on anything that went out unchecked:

```
// unverified: <symbol> against <pkg>@<version> — from recollection,
// settle with: <the command or file that would settle it>
```

In the report or PR body, a short section that lists them: the symbol, the
package and version, why the check was skipped (§2), and the one observation
that would close it. An empty list is a fine result and should be stated as
empty rather than omitted.

And the converse, which is the cheaper half: when you *did* check, say against
what. "Verified against `@aws-sdk/client-s3@3.620.0` types" is a sentence a
reviewer can re-run. "I checked the docs" is not.

Never mark a call verified on the strength of rank 5.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "It compiled, so the API is right." | Compilation proves the shape the *types* declare, and the silent failures live where types do not reach: unknown keys in an option bag, a string enum the library parses at runtime, a config file, a CLI flag. Those compile perfectly and do nothing. |
| "I read the library's documentation, so this is checked." | Not until the version is named. The docs site serves the newest release; this project resolves whatever the lockfile says. An unversioned citation is a remembered call with a footnote — the same defect, harder to spot. |
| "`package.json` says `^4.2.0`, so we are on 4.x." | That is the range the project accepts, not the build that is running. Read `node_modules/<pkg>/package.json`, and when it disagrees with the lockfile, say so — the tree is stale and nobody else's is like it. |
| "The docs show this option but the types do not, so the types are out of date." | Backwards nearly every time. The types ship inside the installed package; the docs describe some version, usually a newer one. The artefact on disk is what executes — name the gap instead of overriding it. |
| "I will write the documented call and add a fallback for the old signature." | You have shipped two branches and exercised one. The dead branch is never run, never tested and wrong in a way nobody discovers, and you took on that debt to avoid reading one file. |
| "This is a well-known library, I have used it a hundred times." | Familiarity is the exposure, not the protection. The APIs recalled most confidently are the ones learned longest ago, so recollection is most stale exactly where it feels safest, and confident wrong calls skip their own review. |
| "A blog post shows this exact pattern working." | It worked, at some version, on some day, for somebody whose lockfile you cannot see. That makes it a lead worth thirty seconds against the installed types — it does not make it evidence, and citing it does not turn a guess into a check. |
| "Checking every call would take all day, so I checked none." | The list is not every call. It is the ones whose failure is silent — option bags, untyped surfaces, effects you cannot observe locally, changed defaults. Typed calls under a type-check are already verified; that is most of them. |
| "I was not sure about two of these, but the rest are solid." | Then the two are invisible, because a diff shows no difference between them and the forty around them. Mark them at the call site with what would settle them, or the reviewer's only options are re-check everything or trust everything. |

## Verification

Do not report the work as done until all of these hold:

- Every dependency call this change introduced is either verified against a
  named source at a named version, or carries an `unverified:` marker at the
  call site.
- Each version named is the one installed on disk — read from the package's own
  installed metadata, not from a manifest range — and any disagreement with the
  lockfile is reported.
- Every check cites its rank (§3): which artefact or versioned document, not
  "the docs". No call is reported as verified on rank 5 alone.
- Where documentation and the installed build disagreed, the report says which
  versions were compared, which side was followed, and why — and no call site
  branches across both.
- The report carries the unverified list — symbol, package, version, reason the
  check was skipped, and the observation that would close it — stated as empty
  when it is empty.
- Any needed behaviour that exists only in a newer release is written up as an
  upgrade decision for the dependency's owner, and no version was bumped inside
  this change to obtain it.

Credit: [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
(MIT) is where the pairing comes from — check the dependency before calling it,
and mark what went out unchecked. The ranks and the version rule are ours.

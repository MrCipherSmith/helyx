# Implementation Plan

Status: formalized

## Approach

One pure function, in the module that already answers "where is `~/.claude`
from here": `utils/transcript-locate.ts`.

```ts
export function localTranscriptPath(
  path: string,
  root = claudeConfigRoot(),
  exists = existsSync,
): string | null
```

1. The path as given, if it exists — the host case, and every test.
2. Otherwise the part after the `/.claude/` segment, re-rooted at `root`, if
   that exists — the container case.
3. Otherwise `null`.

`exists` is a parameter so the branches are testable without a filesystem, and
`root` is a parameter for the same reason — that is how `claudeConfigRoot`
itself is already written.

**Why re-root rather than substitute.** The incoming path was already accepted
by `isAllowedTranscriptPath` (`/home`, `/root` or `/tmp`), and the derived path
never goes through that guard again. So the derivation must be incapable of
pointing anywhere else: only the segment *after* `/.claude/` is carried over,
and a `..` in it rejects the candidate outright.

**Why the two consumers get different fallbacks.** `extractFactsFromTranscript`
runs once at session end; when translation fails it can afford
`resolveTranscript(projectPath)`, which scans up to 40 transcripts and matches
on each file's declared `cwd`. `deliverTurnSummary` runs at the end of every
turn and is explicitly a courtesy that must never delay or fail a turn — it gets
the cheap translation and nothing more.

### Rejected alternatives

- **Translate at the HTTP hook, before dispatch.** It would fix both consumers
  in one line, but `isAllowedTranscriptPath` guards the raw value and the
  handler would then hold a path that no longer matches what it validated.
  Translation belongs next to the read.
- **Recompute the slug from `project_path`.** The slug rule is Claude Code's,
  undocumented and irregular — the module comment already refuses to reproduce
  it, and for good reason.
- **Make the Stop hook send a container path.** The hook runs on the host and
  has no idea a container exists, nor should it.

## Steps

1. `localTranscriptPath` in `utils/transcript-locate.ts`, with tests for each
   branch.
2. `extractFactsFromTranscript` uses it, then `resolveTranscript` as a fallback,
   then warns as today.
3. `deliverTurnSummary` uses it before `deps.read`, keeping its silent-failure
   contract.
4. CHANGELOG entry.

## Risks

- **The fallback resolves the wrong transcript.** `resolveTranscript` matches on
  the transcript's own declared `cwd`, not on a computed slug, so a wrong match
  would need two sessions sharing a working directory — in which case the newest
  is the right answer anyway.
- **A path outside the config root.** Addressed by construction: only the
  post-`/.claude/` segment is carried, and `..` rejects it.
- **Facts start being written for the first time.** That is the point, but it is
  a behaviour change on a system that has been quiet for weeks; the first
  session after deployment should be watched for volume.

# Implementation Plan

Status: formalized

## Approach

A new module, `services/review-artifacts.ts`, rather than more surface on the
699-line `services/reviewer-service.ts`. The engine stays free of the
filesystem, which is what makes it testable today, and the rendering is pure:

```ts
export function renderRunJson(result: ReviewRunResult, meta: RunMeta): string
export function renderReportMd(result: ReviewRunResult, meta: RunMeta): string
export async function persistReviewRun(result, meta, root?): Promise<ReviewArtifact | null>
export async function pruneReviewArtifacts(options?, root?): Promise<{ removed: number }>
```

`meta` carries the clock and the git context, passed in rather than read, so
both renderers are deterministic under test.

**What the record contains is what is actually known.** The package's
specification sketched a per-reviewer `durationMs`; `ReviewerReport` does not
carry one and inventing a plausible number would be worse than omitting it.
Truncation *is* known exactly — a truncated answer arrives as
`ok: false, error: REVIEW_TRUNCATED` — so it is recorded as a flag rather than
left for a reader to pattern-match out of an error string.

**Persistence never changes the exit path.** `scripts/review.ts` prints first
and persists after; a filesystem failure warns on stderr and leaves the exit
code and stdout untouched. The review is the product, the artifact is a
by-product, and CLAUDE.md's `SELF` contract must not become conditional on a
writable disk.

### Rejected alternatives

- **Persist inside `runReviewers`.** It would catch the `/codex_review` path
  too, at the cost of putting the filesystem into the one module that has none.
  The caller knows the trigger and the timing; the engine does not.
- **A database table.** Reports are large text blobs read by people and by
  `keryx memory ingest`, which takes a path. A row would have to be exported to
  a file before it could be used.
- **Keeping only the Markdown.** The rendering is lossy on purpose; a later
  question about which model said what needs the structured record.

## Steps

1. `services/review-artifacts.ts` with the two renderers, the writer and the
   pruner.
2. Tests: rendering against a known result, round-tripping the JSON, pruning
   rules, and a real temporary directory for the writer.
3. `scripts/review.ts` builds the git context and the timing, prints as before,
   then persists and prunes, and adds one `artifact: <path>` line at the end.
4. CHANGELOG entry.

## Risks

- **Artifacts hold diff content.** They live under `logs/`, which is gitignored
  and already holds the same material; nothing is sent anywhere new.
- **Pruning deletes something wanted.** The newest run per branch is never
  pruned, and both limits are parameters.
- **The extra stdout line breaks a caller.** CLAUDE.md reads the reports and the
  bare `SELF`; an appended line is additive, and `SELF` stays the only content
  of the self-review case.

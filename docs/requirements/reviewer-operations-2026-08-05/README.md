# Reviewer Operations

Version: 1.0.0

## Purpose

Make the independent reviewers an operational part of the system rather than a
command someone remembers to run: know they are alive before needing them, keep
what they say, and let a review happen without being asked.

## Status

`spec ready` — nothing in this package is built. The reviewers themselves work
and are in daily use; what is missing sits around them.

The pipeline today: `bun scripts/review.ts "<request>"` runs every enabled
reviewer concurrently (`services/reviewer-service.ts`, `runReviewers`), prints
each report to stdout, and prints the single line `SELF` when all of them are
down. Reviewers are configured through `/reviewers` in Telegram and stored in
`bot_config`. Availability can be checked — `getReviewerStatuses()` probes
Codex login state and the DeepSeek balance — but only when a person opens
`/reviewers`.

**Merged, not deployed** (2026-08-05). Every flow in this package is squash-merged
into `main`; none of it is running. The bot container and the channel
subprocesses still carry the pre-programme code, and the status here stays
`spec ready` until a rebuild and a session bounce make it true — the vocabulary
in [`../roadmap.md`](../roadmap.md) reserves `implemented` for deployed code,
and this programme spent a flow (034) on exactly that distinction.

Flows: 031 (G2), 032 (G1), 033 (G3) — PRs #67, #68, #69.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, scope |
| [prd.md](prd.md) | Problem, evidence, requirements, success criteria, risks |
| [specification.md](specification.md) | Storage, loop, CLI surface, data contracts, acceptance criteria |

## Scope

In scope:

- **G1** — reviewer availability is polled on a schedule and a transition into
  unavailable (or a balance below a floor) raises one alert.
- **G2** — reviewer reports are persisted: a run produces a durable artifact,
  and accepted findings can be fed to project memory through the ingest path
  that already exists, `keryx memory ingest --from-review`.
- **G3** — a review can run without a person asking for it, on a defined
  trigger, with its report stored under G2.

Out of scope, and why:

- Changing what the reviewers are asked or how the diff is budgeted. Those are
  measured and settled (`REVIEW_DIFF_BUDGET_BYTES`, `REVIEW_MAX_TOKENS`, the
  truncation marker) and this package does not touch them.
- Adding or removing reviewer backends. `/reviewers add|remove` covers that.
- Acting on findings automatically. A stored report is read by a person or an
  agent; nothing here edits code.
- Blocking a push on a review verdict — see PRD §7, where it is rejected with a
  reason rather than left unmentioned.

## Related Modules

| Area | Path | Relevance |
|------|------|-----------|
| Reviewer engine | `services/reviewer-service.ts` | `runReviewers`, `getReviewerStatuses`, budgets |
| CLI wrapper | `scripts/review.ts` | The 34-line entry point that prints and forgets |
| Telegram surface | `bot/commands/reviewers.ts` | `/reviewers` — add, remove, status |
| Reviewer config | `bot_config` key `reviewers` | Enabled reviewers, kind, model |
| Providers | `services/provider-service.ts` | Auth and base URL for provider reviewers |
| Supervisor loops | `scripts/supervisor.ts` | Where a scheduled probe belongs |
| Project memory | `keryx memory ingest --from-review` | The existing receiver with no sender |
| Repo convention | `CLAUDE.md` § Code Review with Reviewers | Defines the `SELF` fallback contract |

# Summarize Before The Context Folds

Version: 1.0.0

## Purpose

Run Helyx's summariser before Claude Code compacts its own context, instead of
discovering afterwards that the material worth summarising has already been
replaced.

## Status

`spec ready` — written 2026-08-07 at the operator's request, after establishing
that the interception point exists and that the number is measurable.

| Question | Answer | Source |
|---|---|---|
| Is there a hook for it? | Yes — `PreCompact`, with a `manual`/`auto` matcher, and it can block | Claude Code hooks reference |
| Can Helyx already install hooks? | Yes — `Stop` and `PreToolUse` are installed by the setup wizard | `cli.ts:900-1045` |
| Is the context size knowable? | Yes — `message.usage` in the transcript | `utils/transcript-locate.ts:46` |
| Measured on this session | 611 571 tokens | `input_tokens + cache_read + cache_creation` |
| Does Helyx summarise busy sessions today? | No — only sessions idle ≥ `IDLE_COMPACT_MIN` | `scripts/supervisor.ts`, idle auto-compact |

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, established facts |
| [prd.md](prd.md) | Problem, measurement, the three layers, acceptance, risks |
| [code-review.md](code-review.md) | Review of the implementation — four silent defects in the denominator and its configuration, all fixed |

## The proposal in one paragraph

Read the context size from the transcript — it is already there, and `/now`
already reads that file — and summarise at 85% while the session is idle, not at
98% when there is no room left to do it. Keep `PreCompact` as the safety net for
context that grows in a single step, and let it work inline under a timeout
rather than blocking the fold, because a session that cannot compact cannot
continue. Putting the summary back *after* the fold is a separate decision and
is deliberately not part of this.

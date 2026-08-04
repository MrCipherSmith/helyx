# What a file becomes, and what the numbers say

Status: ready
Source: operator choice, 2026-08-04

## Problem

`bot/media.ts` is at 3.7% line coverage and `bot/commands/admin.ts` at 3.4%.
Both are read by the operator every day and neither is watched.

**A file's fate is decided by one unwatched branch.** `deliverMedia` chooses
between inlining an image as base64 and passing a path. Inline the wrong thing
and the payload carries megabytes it should not; pass a path where an inline
was needed and Claude never sees the picture at all. The threshold, the mime
handling and the fallbacks are all in a function that no test reaches, tangled
with downloads and queue writes.

**An argument that reads as a number is not necessarily one.** `/permission_stats -5`
parses to -5, which survives `Math.min(-5, 365)` and reaches
`make_interval(days => -5)` — a window ending before it starts. The operator
gets "No permission requests in the last -5 days" for a database full of them.

## Expected Outcome

- The attachment decision is a pure function with the threshold named, tested
  on both sides of it.
- The stats window is parsed by something that refuses nonsense rather than
  passing it to the database.
- The bars and percentages the operator reads are tested, including the
  divide-by-zero they are one row away from.

## Out of Scope

- Downloading, transcription and the queue. Those are plumbing around the
  decision, not the decision.
- The other admin handlers, which are DB reads formatted straight out.

# M1 — added latency, measured on the crossings only (A1.11)

The acceptance criterion: "Added latency is measured on the crossings only; the
operator path is unmeasured because it is untouched (M1)."

## The operator path adds zero, and this is structural, not measured

The operator channel (`channel/tools.ts` `reply`, `mcp/tools.ts` `reply`) invokes
no scanner — it never calls `guardOutbound`/`guardInbound`/`runScan`. This is
proven by `tests/unit/operator-channel-no-scan.test.ts` (A1.1), a source-level
guard that fails the moment any scanner symbol appears in either file. There is
nothing to time on the operator path because there is no added work: latency
added to a `reply` is exactly 0 by construction, not by measurement.

## The crossings each add one `keryx security check-output` spawn

Measured directly on 2026-08-13 against installed keryx v0.2.28, one scan of a
short clean payload (`printf … | keryx security check-output --json --target
external`), five runs:

| run | wall-clock |
|---|---|
| 1 | 1.25s |
| 2 | 1.69s |
| 3 | 0.72s |
| 4 | 0.90s |
| 5 | 0.71s |

Median ≈ 0.90s, dominated by CLI cold-start. The scan is bounded by
`policy.timeoutMs` (default 3000ms; `EXTERNAL_BOUNDARY_SCAN_TIMEOUT_MS`); a scan
that exceeds it is a scan failure and takes the crossing's fallback, so the added
latency on a crossing is bounded at the timeout, never unbounded.

## Why this cost is paid where it is, and not where it is not

Every crossing that pays this is already a call to a remote service — a TTS
synthesis, a reviewer model, an auxiliary LLM — each of which already costs
hundreds of milliseconds to seconds of network time. One local `keryx` spawn of
~0.9s median is the same order as the call it guards, and it guards a call the
operator is already waiting on, not a `reply` they are not.

The operator's `reply` — the one path that must be fast and must never be held —
pays none of it.

## Follow-up worth recording (not required by A1.11)

The per-scan cost is a fresh process each time. If a crossing is ever put on a
tight loop, a persistent `keryx security serve`-style scanner or an in-process
check would remove the cold-start; not needed at current call volumes (TTS and
reviewers are human-paced), recorded so the number above is not mistaken for a
floor that cannot move.

# Flow Journal

- 2026-08-02T15:17:04.435Z - flow created
- 2026-08-02T15:17:28.465Z - frozen: 10 criteria; checksum recorded
- 2026-08-02T15:17:28.548Z - started
- 2026-08-02T15:17:28.667Z - task-done: T1: Collect remaining context
- 2026-08-02T15:21:02.100Z - task-done: T2: Implement per plan
- 2026-08-02T15:21:02.189Z - task-done: T3: Add/adjust tests and make them pass

## Codex review, 2026-08-02

Verdict: REQUEST CHANGES — one blocker, one major, two minor. All four fixed.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | blocker | Acquire and release each recomputed `stateKey` from a mutable forum topic, while the render read the key captured in `StatusState`. A topic refresh mid-prompt would release a key nobody holds — leaving 💬 up forever — or one another prompt holds. | **Fixed.** `holdAwaitingPermission` resolves the key once and captures it in the lease it returns. |
| 2 | major | Changing the latch triggered no redraw. A prompt answered quickly would never show 💬 at all; one answered slowly would keep showing it until the next timer tick. | **Fixed.** `renderPhaseChange` redraws on both acquire and release, reusing the same `editInFlight` guard `updateStatus` uses so it cannot race the timer. |
| 3 | minor | A keyed `release(key)` has no identity: one holder calling it twice consumes another holder's hold. | **Fixed.** `acquire` returns the lease that releases *that* hold; calling it twice is a no-op. Tested, including a stale lease released after the key was emptied and taken again. |
| 4 | minor | Tests covered the pieces in isolation and missed mutable topic keys, fast resolution and the lifecycle paths. | **Partly fixed.** The lease semantics are covered; the acquire-to-render integration and the four lifecycle exits still are not, because they need a live Telegram round trip. Said plainly in the PR rather than implied away. |

Findings 1 and 3 are the same root cause seen from two sides: an identifier
recomputed at each use rather than captured once. That is the third flow in a
row where the fix was to stop re-deriving something and start holding onto it —
after the shared ANSI parser and the shared prompt definition.
- 2026-08-02T15:33:20.397Z - task-done: T4: Self-review and prepare draft PR

### Second Codex pass

Findings 1 and 3 confirmed resolved. Finding 2 came back **partially**
resolved, correctly: both edges now request a redraw, but an edge arriving
while an edit was in flight only set `pendingImmediateEdit`, and only the 5s
timer drained it. So the latch could still show a tick late — which for a
stage is a stale line, and for the latch is the wrong emoji on a session that
is or is not blocked.

Fixed with a shared single-flight drain, `editWithDrain`: a caller that finds
an edit running records that another is wanted and returns, and the running
edit repeats before finishing. `updateStatus`, `renderPhaseChange` and the
timer all go through it, and the timer's own drain became a loop rather than a
single extra pass — it too could only absorb one buffered update.

Codex also noted that a live Telegram round trip is not strictly required for
the lifecycle tests, and that fakes could cover the four exits. Fair, and
recorded as the next step for this area rather than claimed as done: it needs
a fake `ctx` for the permission handler (sql, mcp, token, session), which is a
fixture this repository does not have yet and is worth building deliberately
rather than as a side effect of this flow.

### Third Codex pass — one owner for the edit guard

Three points, all correct.

- `sendStatusMessage` still owned `editInFlight` itself without draining, so a
  latch edge landing during that edit waited for the timer after all. The fix
  had covered two of the three paths and I had reported it as done.
- `editWithDrain` could loop for as long as updates kept arriving — which is
  precisely when Telegram is most likely to be rate-limiting — and would never
  reach `nextEditDelay`, the backoff the timer honours.
- The timer still carried its own copy of the drain protocol.

Now there is exactly one `editInFlight = true` in the file, inside
`editWithDrain`, and all three paths call it. The drain is capped at four
passes and breaks early once a rate-limit backoff has been recorded; anything
still pending after that is the timer's, one tick later.

The pattern from findings 1 and 3 of the previous pass repeated here at a
larger scale: the same protocol written out in three places, differing in each.
Routing them through one function is the same move as the shared ANSI parser,
the shared prompt definition and the captured latch key — four flows in a row
where the fix was to stop repeating something and start sharing it.

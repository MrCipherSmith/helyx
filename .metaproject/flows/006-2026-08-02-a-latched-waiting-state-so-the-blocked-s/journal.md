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

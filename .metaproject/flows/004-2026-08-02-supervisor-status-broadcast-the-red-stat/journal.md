# Flow Journal

- 2026-08-02T13:45:38.594Z - flow created
- 2026-08-02T13:46:34.556Z - frozen: 10 criteria; checksum recorded
- 2026-08-02T13:46:34.641Z - started
- 2026-08-02T13:46:34.729Z - task-done: T1: Collect remaining context
- 2026-08-02T13:49:21.236Z - task-done: T2: Implement per plan
- 2026-08-02T13:49:21.332Z - task-done: T3: Add/adjust tests and make them pass

## Codex review, 2026-08-02

Verdict: REQUEST CHANGES. Two major, one minor.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | major | Stopped containers and docker-command failures never reach `hasProblems`. `docker ps` omits exited containers, and `2>/dev/null \|\| true` turns a dead daemon into empty output — an empty container set reads as "all healthy". | **Partly fixed.** The unreadable-listing half is fixed: `dockerListingUsable` distinguishes "docker answered with nothing" from "docker could not be read", and the latter is a problem in its own right and says so in the message. The stopped-container half is **not** fixed and is deliberate — see below. |
| 2 | major | The allowlist was only an allowlist at the first word. Within `Up`, it was still a blacklist of two substrings, so the real `Up … (health: starting)` and any future annotation passed as healthy — contradicting the fail-closed contract the function's own comment claimed. | **Fixed.** An `Up` status with no annotation is healthy (no healthcheck defined); with an annotation, only `(healthy)` passes. Everything else, named or not, is a problem. |
| 3 | minor | Tests covered the helpers but not `sendStatusBroadcast`, nor docker failure, `health: starting`, or unknown annotations. | **Fixed for the helpers** — 10 tests added. `sendStatusBroadcast` itself takes `sql` and posts to Telegram; covering it needs a fixture for both and belongs to a flow that builds one. Recorded rather than silently skipped. |

### Why the stopped-container half is not fixed here

Switching to `docker ps -a` would make every stopped container on the host a
problem. This host runs 21 containers across four unrelated projects, most of
them nothing to do with helyx, and several are stopped by design. Deciding
which containers this supervisor is responsible for is a product question with
no answer in the code today, and answering it by listing everything would turn
the broadcast into permanent noise — which is how alerting gets ignored.

Recorded as the follow-up this needs: a list of required containers, or a
label, and then `-a` against that list.

### `health: starting` is a deliberate cost

A container inside its healthcheck start period now reads as not healthy, so a
restart will notify. The alternative is a rule that says "starting is fine",
which is the same shape of assumption that hid the crash loop. The broadcast
runs every five minutes; a start period long enough to be seen by it twice is
worth knowing about.

After the fixes: 546 tests pass (from 536), coverage 17.72%, and this host's
real `docker ps` output still classifies 21/21 healthy with no false reds.

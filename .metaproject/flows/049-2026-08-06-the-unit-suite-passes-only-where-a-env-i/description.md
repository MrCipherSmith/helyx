# The unit suite passes only where a .env is, and CI has been red for a day

Status: frozen
Source: user description

## Problem

`bun test tests/unit/` is green on the developer's machine and red in CI, and
has been red in every one of the last twelve workflow runs — a full day of
merges that went in past a gate nobody could read. Eight tests fail there and
nowhere else.

The cause is not eight separate defects. `utils/tts.ts` captures its provider
credentials in module constants at import time, so whether a provider is part
of the chain is decided by whatever `.env` happens to sit beside the checkout.
On this machine `YANDEX_API_KEY` and `GROQ_API_KEY` are set, the Russian chain
starts at Yandex, and the tests describe that chain. On a clean checkout the
Yandex step is skipped in silence, synthesis falls through to Piper, and five
`tts-chain` tests plus one `tts-delivery` test assert a chain that did not run.
Reproduced locally by blanking the two keys: the same five failures, in the same
order.

Two more fail for reasons of their own. `dashboard-auth` asserts that
`/index.html` is served by the dispatcher, which requires a built
`dashboard/dist` — gitignored, present here, absent in CI. And
`supervisor-gemma-loop` sees a Telegram request it never made: `bun test` runs
every file in one process, so something else in it called `fetch` while that
test owned the stub. What that something is has not been established here, and
is not claimed to be; ten runs, four under the reproduced CI condition, never
showed it again.

The same log does show a defect worth the trip, and it is in production code
rather than in a test: Piper writes to `/tmp/piper-tts-${Date.now()}.wav` and
deletes it in an asynchronous `finally`, so two syntheses starting inside the
same millisecond delete each other's audio. In the CI log that is an `ENOENT`
on a file the process had written moments earlier — reachable in production any
time two replies are spoken at once.

Separately, and by the operator's decision: Yandex is not to be used for now. It
is first in the Russian chain today, which means every spoken reply pays for a
provider we do not want.

## Expected Outcome

The unit suite gives the same answer on any machine, with or without a `.env`,
and CI on `main` is green. The Russian voice chain tries Piper before Yandex.
Flow 048, blocked on green checks it never had, can be closed.

## Out of Scope

- Restarting anything. The operator asked explicitly for the fix alone; no
  container rebuild, no session bounce, no deploy.
- Removing Yandex. It is demoted, not deleted — the credentials stay, the
  provider stays reachable, it is simply no longer first.
- The eight React lint errors the CI file already names as their own work.

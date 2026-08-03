# The status broadcast, and what the supervisor is answerable for

Status: formalized

## Problem

Two things, and the second is why the first was stuck.

`sendStatusBroadcast` is the five-minute report the operator actually reads:
containers, sessions, queue. It was uncovered, and it lists containers with
`docker ps` — which shows only what is running. A container that crashed does
not appear as broken; it vanishes. A vanished container is indistinguishable
from one that was never there, which is how the red state stayed unreachable
for weeks while a crash loop reported green.

`docker ps -a` shows it, at the price of also showing everything else on the
host. That was the open question: which containers is this supervisor
answerable for? Without an answer, the safe move was to keep listing only what
was running, and keep the blind spot.

The maintainer's answer, 2026-08-03: helyx's own stack, and the containers of
projects running under it. Nothing else on the machine.

## Expected Outcome

`isOurContainer(name, scope)` decides ownership from the compose naming
convention rather than from a substring, so `my-helyx-experiment` is not adopted
by accident. `parseContainerLine` reads a listing line, or says it is not one —
the command runs with `2>/dev/null || true`, so an error message can arrive
where a listing was expected.

The broadcast uses `-a`, filters to the scope, and escapes the status text
before it becomes markup: docker's wording is not ours, and the message is sent
with `parse_mode: HTML`.

Then coverage of the broadcast itself and the two small loops beside it.

## Out of Scope

- `checkGemmaHealth` and `collectSystemSnapshot`. They are the next instalment.
- `checkIdleSessions`, which summarises through the memory layer and wants that
  layer's fixtures first.

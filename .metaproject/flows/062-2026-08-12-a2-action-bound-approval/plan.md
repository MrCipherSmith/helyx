# Implementation Plan

Status: ready
Source: docs/requirements/keryx-adoption-2026-08-12/implementation-plan.md §A2

## Approach

Add a fingerprint gate **above** the existing lease, not in place of it. The
gate is a pure function plus a small store; the restart call sites gain two
lines each (derive, verify) before their existing `claimRestart()`.

The fingerprint is deliberately coarse — `half` / `scope` / `downtime` — because
a fingerprint over the command string would re-ask on every trivial variation
and train the operator to approve without reading, which is the failure being
prevented arrived at by another road.

## Steps

1. Grant store per the package schema: `grantId`, `kind`, `fingerprint`,
   `requestId`, `issuedAt`, `expiresAt`, `consumedAt`, `issuedBy`, `statedTo`.
2. `fingerprintOf(action)` — pure, total, and the single place a command maps to
   `half`/`scope`/`downtime`.
3. Confirmation text states the fingerprint in words before asking; the exact
   sentence is persisted as `statedTo`.
4. Gate at `scripts/admin-daemon.ts` :416, :494, :522 — re-derive, compare,
   then `claimRestart()`. An unapproved action must not take the lease.
5. `cli.ts` `"bounce"` branch: same gate, or an explicit refusal while another
   restart is in flight.
6. No approver reachable → deny, with the standing grant that makes it
   survivable: the watchdog holds `sessions`/`<project path>`/`brief` per
   watched project and nothing wider.
7. Tests for AC1–AC13.

## Risks

- The standing grant is the only exemption from single-use in the package. Its
  safety is entirely its narrowness: if the watchdog's grant can ever match an
  action wider than one project's sessions, the exemption is a hole. AC9 exists
  to catch exactly that.
- Step 6 changes unattended behaviour. Too strict and a 4am hang becomes an
  outage until morning; too loose and the gate is decorative.
- A fingerprint defined too narrowly produces approval fatigue, which ends in
  blanket approval — the original failure, restored.

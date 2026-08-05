# The dashboard API is the largest untested surface in the repository

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C6)

## Problem

`mcp/dashboard-api.ts` has 947 uncovered lines — more than any other file — and
it is the only place in the system that answers requests from outside it. Every
route behind `/api/` is reachable from a browser.

Its dispatcher carries the two guards that decide whether a request is answered
at all: a JWT check on everything under `/api/`, and an Origin check on anything
that changes state. Nothing tests either. A change that let one of them through
would be invisible until somebody noticed data leaving.

The file also holds `handleDashboardRequest`, which is already a named exported
function taking a request, a response and a URL — so unlike `mcp/server.ts`,
none of this needs a port or a refactor to reach.

## Expected Outcome

- The auth gate is tested: no token is 401, a valid token is served, and both
  the cookie and the `Authorization: Bearer` form are accepted.
- The CSRF guard is tested: a state-changing request from a foreign origin is
  refused, and one from the same host is not.
- The dispatcher's contract is tested: a path it does not own returns false so
  the caller can fall through to the static file server.

## Out of Scope

- The individual data routes' SQL. They are thin queries over the database, and
  the decisions worth pinning are the guards in front of them.
- The static file serving, whose containment check lives in
  `utils/request-guards.ts` and is tested there.

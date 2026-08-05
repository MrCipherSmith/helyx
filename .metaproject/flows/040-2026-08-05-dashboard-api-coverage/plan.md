# Implementation Plan

Status: formalized

## Approach

`handleDashboardRequest(req, res, url)` is a plain function. The test builds a
request and a response that record what was written, calls it, and reads the
answer — no server, no port, no browser.

The JWT is real: `signJwt` from `dashboard/auth.ts` produces one the handler
will accept, so the test proves the gate opens for a genuine token rather than
that a mock said yes.

Database access goes through `FakeSql` via the same module replacement the
summarizer tests use, because this module also imports `sql` rather than
receiving it.

The cases are the guards, in the order a request meets them:

1. A path the dispatcher does not own — it must return `false`, or the caller
   stops serving the dashboard's own files.
2. `/api/*` with no credentials — 401.
3. `/api/*` with a token in a cookie, and the same with a Bearer header.
4. A state-changing request from a foreign origin — 403, even with a valid
   token.
5. The same request from the host it claims to be — allowed past the guard.

### Rejected alternatives

- **Start the HTTP server and use `fetch`.** The port is fixed and already
  taken on this host, and the guards are reachable without it.
- **Assert on every data route.** They are thin queries; the guards are what a
  regression would let through.

## Steps

1. `tests/unit/dashboard-auth.test.ts` with request and response doubles.
2. Re-measure and record before and after.
3. CHANGELOG entry.

## Risks

- **A real JWT needs a secret.** It is derived from the bot token when
  `JWT_SECRET` is unset, so the test signs and verifies with whatever this
  environment already uses — the same path production takes.
- **The doubles drift from Node's real types.** They are typed as the real ones
  at the call boundary, so a signature change breaks the test rather than
  silently passing.

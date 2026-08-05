# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A request that matches nothing at all returns `false`, so the caller can answer it; and the premise is stated correctly — this dispatcher *is* the static file server, so an asset path returns `true` rather than falling through. Both proved by test.
- AC2: A request under `/api/` with no credentials is answered 401 and is reported as handled; proved by test.
- AC3: A request with a genuine JWT — signed by the module that verifies it, not by a mock — is served rather than refused; proved by test.
- AC4: Both credential forms are accepted: a `token` cookie and an `Authorization: Bearer` header; proved by test.
- AC5: A state-changing request whose `Origin` does not match its `Host` is refused 403 even with a valid token; proved by test.
- AC6: The same request from a matching origin passes the CSRF guard; proved by test.
- AC7: A malformed or forged token is treated as no token; proved by test.
- AC8: `mcp/dashboard-api.ts` line coverage is measured before and after and both figures are recorded.
- AC9: Whole unit suite green and `tsc --noEmit` clean.
- AC10: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC11: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

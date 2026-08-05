# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The request router is an exported named function taking `(req, res, bot)`, and `createServer` is passed it rather than an inline arrow.
- AC2: The extraction is a move: the body, the route order and the responses are unchanged, and the diff shows no rewritten logic.
- AC3: `isLocalRequest` is exported and tested directly, including the Docker bridge range and an IPv4-mapped IPv6 address.
- AC4: An unknown route answers 404 through the extracted function, with no socket and no port bound.
- AC5: `/mcp` from an address outside loopback and the bridge is refused 403; a local request without a session id gets 400.
- AC6: `/api/hooks/stop` is pinned on all three refusals: not local, missing fields, and a transcript path that escapes its directory.
- AC7: `/api/hooks/ask-question` refuses a local caller carrying the wrong shared secret.
- AC8: No test in this flow reaches a database, opens a socket, or starts background work.
- AC9: `mcp/server.ts` line coverage is measured before and after and both figures are recorded.
- AC10: Whole unit suite green, `tsc --noEmit` clean, and the change recorded in `CHANGELOG.md`.
- AC11: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

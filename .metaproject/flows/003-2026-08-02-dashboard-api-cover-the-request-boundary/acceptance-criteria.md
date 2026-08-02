# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/request-guards.ts` exists and exports `containsPath`, `resolveStaticPath`, `parseCookieHeader`, `sanitizeGitRef`, `isSafeRepoPath` and `hostToContainerPath`.
- AC2: A test reproduces the demonstrated escape — a request resolving into a sibling directory whose name shares a prefix with the root (`dist` / `dist-evil`) — and asserts it is now refused.
- AC3: `containsPath` is tested for: the root itself, a child, a nested child, a prefix-sharing sibling, a parent, and an unrelated path.
- AC4: `mcp/dashboard-api.ts` contains no `startsWith`-based containment check and no inline cookie or git-ref parsing; all six decisions are called from the module.
- AC5: `parseCookieHeader` is tested for: absent header, absent cookie, a value containing `=`, a cookie whose name is a prefix of another, and surrounding whitespace.
- AC6: `sanitizeGitRef` is tested for: an accepted ref, a rejected ref falling back, the 200-character limit, and that `_` is accepted — the character the escaped `-` in the class protects.
- AC7: `hostToContainerPath` is tested for: a path under the projects dir, a prefix-sharing sibling that must NOT be rewritten, the legacy host-home fallback, and an unset legacy mount leaving the path unchanged.
- AC8: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC9: The dashboard is served locally and verified end to end: a real asset returns 200, and a traversal attempt into a prefix-sharing sibling does not return that sibling's content.
- AC10: `keryx health run` reports coverage strictly above the 17.00% recorded at flow start, with no new gate failure reason beyond the pre-existing coverage warning.

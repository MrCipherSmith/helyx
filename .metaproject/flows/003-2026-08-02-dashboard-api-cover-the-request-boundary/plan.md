# Implementation Plan

Status: agreed

## Approach

One module, `utils/request-guards.ts`, because these five decisions share a
property that a "helpers" drawer would hide: each one is the last thing that
runs before untrusted input reaches the filesystem, a shell, or an auth check.
Keeping them together is how the next person finds all of them.

- `containsPath(root, candidate)` — separator-aware containment. Equal paths
  count as contained; a sibling sharing a prefix does not. Replaces the
  `startsWith` in both static handlers.
- `resolveStaticPath(root, requestPath)` — join, resolve, contain, returning
  `null` when the result escapes. The two static handlers currently spell this
  out twice with slightly different wording.
- `parseCookieHeader(header, name)` — the cookie lookup, including the
  value-contains-`=` case the current implementation already handles.
- `sanitizeGitRef(raw, fallback)` — the existing allowlist, unchanged, as a
  named function. The escape before `-` inside the character class stays: it
  is what stops `_` to `/` being read as a range, and removing it turns the
  guard into a SyntaxError. There is already a lint-config comment about this.
- `isSafeRepoPath(path)` — the current `..` rule, named and documented as the
  blacklist it is, with a comment pointing at the flow that should replace it.

`hostToContainerPath` moves too, taking its two directories as parameters
instead of reading `process.env` inline, and gains the separator check.

The containment fix is a behaviour change, and the only one in this flow: a
request that previously escaped into a prefix-sharing sibling is now refused.
Nothing else changes.

## Steps

1. `utils/request-guards.ts` with the six functions.
2. Migrate `serveStatic`, `serveWebApp`, `parseCookie`, `handleGitFile` and
   `hostToContainerPath` in `mcp/dashboard-api.ts`.
3. Tests, including the demonstrated `dist-evil` escape as a regression case.
4. `bun run typecheck`, `bun run lint`, `bun test tests/unit/`,
   `keryx health run`.
5. Serve the dashboard locally and fetch a real asset plus a traversal attempt,
   because nothing tests the wiring between the router and these guards.

## Risks

- **Tightening containment can break a legitimate path.** The dashboard is
  served from `dist` and the Mini App from `webapp/dist`; neither is a
  prefix-sharing sibling of the other's root, so no served asset should move.
  Step 5 exists to confirm that rather than assume it.
- **`hostToContainerPath` reads `process.env.HOST_HOME` twice** — once to
  decide whether the legacy mount is configured, once for its value. Passing it
  in must preserve "unset means do not use the fallback", which is not the same
  as "empty".
- **The git ref regex is easy to break while moving it.** It is copied
  verbatim, and a test asserts a character class member that a careless edit
  would drop.

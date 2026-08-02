# dashboard-api — cover the request-boundary decisions

Status: formalized
Source: user description (заход 3 of the coverage programme)

## Problem

`mcp/dashboard-api.ts` is 1170 lines and holds the highest single-function
complexity in the project (118). It is also the only file here that takes
input straight off the network: every request to the dashboard and the
Telegram Mini App lands in it. Five decisions at that boundary are pure, are
what stands between a request and the filesystem or a shell, and none of them
is tested.

**One of them is demonstrably wrong.** `serveStatic` and `serveWebApp` contain
the escape after resolving a path:

```
resolve(join(DIST_DIR, pathname)).startsWith(DIST_DIR)
```

A prefix test is not a containment test. With `DIST_DIR` at
`/app/dashboard/dist`, the request `/../dist-evil/secret` resolves to
`/app/dashboard/dist-evil/secret`, which starts with `/app/dashboard/dist` and
so passes the guard. Demonstrated, not theorised:

| Request | Resolves to | Guard says |
|---|---|---|
| `/index.html` | `/app/dashboard/dist/index.html` | pass ✓ |
| `/../dist-evil/secret` | `/app/dashboard/dist-evil/secret` | **pass ✗** |
| `/../../etc/passwd` | `/app/etc/passwd` | reject ✓ |

No sibling directory beginning with `dist` exists in the shipped image today,
which is the only reason this is not exploitable — a naming accident, not a
control. The same shape is in `hostToContainerPath` (`dashboard-api.ts:22`),
which maps a host path into the container by prefix with no separator check.

The other three are untested rather than wrong:

- `parseCookie` (`:74`) — where the session token comes from on every
  authenticated request.
- The git ref allowlist (`:399`) — `/^[a-zA-Z0-9._\-\/~^:]{1,200}$/`, which
  decides what reaches `git show`.
- The repository path guard (`:397`) — `file.includes("..")`, a blacklist
  standing in for a containment check.

## Expected Outcome

The five decisions live in one importable module with tests that exercise the
real implementations, `dashboard-api.ts` calls them, and the containment guard
answers correctly for a sibling directory that shares a prefix with the root.

## Out of Scope

- Reducing the 118-complexity router. This flow extracts guards, it does not
  restructure request dispatch.
- Any change to authentication, JWT handling or the Telegram init-data check —
  `verifyTelegramLogin` and `verifyWebAppInitData` live elsewhere and are not
  touched.
- Replacing the `..` blacklist with real containment for git paths. Whether
  that is safe depends on what `git show ref:path` accepts, which needs its own
  flow with its own tests; this one states the current rule and covers it.
- The SQL in the handlers.

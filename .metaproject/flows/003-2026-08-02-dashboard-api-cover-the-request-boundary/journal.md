# Flow Journal

- 2026-08-02T12:17:59.632Z - flow created
- 2026-08-02T12:19:14.350Z - frozen: 10 criteria; checksum recorded
- 2026-08-02T12:19:14.434Z - started
- 2026-08-02T12:19:14.523Z - task-done: T1: Collect remaining context
- 2026-08-02T12:23:07.121Z - task-done: T2: Implement per plan
- 2026-08-02T12:23:07.205Z - task-done: T3: Add/adjust tests and make them pass

## Codex review, 2026-08-02

Verdict: REQUEST CHANGES. One major, three minor; all four accepted and fixed.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | major | `resolveStaticPath` is lexical only. A symlink planted inside a static root spells a contained path but points outside it, and `readFile` follows the link. | **Fixed.** `resolveStaticPathReal` resolves the link and contains the *real* path too, with `realpath` as a parameter. Both handlers use it. Verified with an actual symlink from `dashboard/dist/escape.txt` to a file in /tmp, fetched over HTTP through the exported router: the request is refused and `grep` for the target's content in the response returns 0, while the control `cat` proves the link really resolves outside. |
| 2 | minor | `containsPath` trusted its inputs to be canonical: `containsPath("/srv/dist", "/srv/dist/../secret")` returned true, a root with a trailing separator did not contain itself, and an empty root silently meant the working directory. | **Fixed.** Both sides are resolved inside, and an empty root fails closed. |
| 3 | minor | `hostToContainerPath` did not normalise its configured directories — a trailing separator stopped it claiming children. | **Fixed**, and the fix surfaced an edge the review did not name: trimming turned a directory of `/` into the empty string, which silently disabled the mapping. A root of `/` now survives as itself and its remainder is computed accordingly. |
| 4 | minor | Tests covered lexical behaviour only — no symlinks, empty or relative roots, or trailing separators. | **Fixed.** 14 tests added across those cases, including a root that is itself a symlink (files under it must still resolve as contained) and that a lexical escape is refused before the filesystem is consulted at all. |

Windows separators were also raised. Not handled deliberately: this code runs
in a Linux container and on Linux hosts, and adding a path flavour nothing
exercises would be untested surface rather than protection.

After the fixes: 505 tests pass (from 491), tsc clean, eslint 0 errors,
coverage 17.42%.

### Second Codex pass

Findings 2, 3 and 4 confirmed resolved; the Windows exclusion was accepted.

Finding 1 came back **unresolved**, correctly. Both handlers validated the
requested path and then, when the file did not exist, replaced it with
`join(DIST_DIR, "index.html")` — an unvalidated path — before reading. The SPA
fallback is not attacker-controlled, so this is not a request-triggered
escape; but the invariant the guard exists to hold is "never read outside the
root", and a deployed `index.html` that is itself a symlink would break it
through a door no request had to open.

Fixed: both fallbacks go through `resolveStaticPathReal` as well. Verified by
replacing `dashboard/dist/index.html` with a symlink to a file in /tmp and
requesting `/` and a missing path over HTTP — both refused, zero occurrences
of the target's content in either response, while `cat` on the link confirmed
it resolved outside. index.html restored afterwards.

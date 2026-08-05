# Implementation Plan

Status: formalized

## Approach

### The installer writes both

`cli.ts` writes `ENABLE_DASHBOARD=${enableDashboard}` and nothing else. It gains
`WITH_DASHBOARD=${enableDashboard}` beside it, with the comment saying why the
two are written together: the runtime flag without the build flag is the bug
this flow exists for.

### A bot told to serve what it does not have says so

`utils/dashboard-readiness.ts`: given the two flags and whether each dist
directory has anything in it, answer what is wrong and what to run. Pure, so
the message can be asserted rather than eyeballed.

Two callers:

- **Startup.** One line at error level, naming `WITH_DASHBOARD=true` and the
  rebuild. A message that says "empty" without saying what to type costs the
  reader the same search every time.
- **The request.** `/webapp/` answers with that sentence instead of falling
  through to a 404 that means "no such route". A 404 is not wrong, but it is the
  wrong 404: it says the route does not exist when the route is fine and the
  build is missing.

### The button is not offered for a page that is not there

`bot/bot.ts` sets the Mini App menu button whenever a webhook URL is configured,
knowing nothing about the dashboard. It gains the same condition the page has.

## Steps

1. `utils/dashboard-readiness.ts` and its tests.
2. The startup line and the `/webapp` answer.
3. The installer.
4. The menu button.
5. CHANGELOG.

## Risks

- **Reading a directory on every request would be a syscall per hit.** The
  answer is computed once at startup and reused; a rebuild restarts the process
  anyway.

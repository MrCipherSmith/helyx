# The dashboard is enabled at runtime and absent from the image

Status: formalized
Source: operator, 2026-08-05 — a screenshot of the Mini App showing `Not Found`.

## Problem

The Mini App opens `/webapp/` and Telegram shows `Not Found`. The route exists
and is correct; the files are not there. Inside the container
`/app/dashboard/webapp/dist` is an empty directory, so `serveWebApp` finds
nothing, answers "not mine", and the request falls through to the catch-all 404.

Two flags have to agree and nothing makes them:

- `WITH_DASHBOARD` is a **build** argument. It defaults to `false` because the
  dashboard build stages are what take the image from 256 MB to a gigabyte, and
  the webapp build is the step that has run a small host out of memory. When it
  is false the Dockerfile creates the dist directories empty so the later `COPY`
  still resolves.
- `ENABLE_DASHBOARD` is a **runtime** flag, and it is `true` here.

`docker-compose.yml` warns about exactly this pairing in a comment — "building
without the dashboard and enabling it at runtime yields empty pages" — and the
comment is all there is. The installer writes `ENABLE_DASHBOARD` on every fresh
install and never writes `WITH_DASHBOARD` at all, so an install that answers
"yes" to the dashboard question gets a container built without one.

The failure is silent in the way that matters: the bot starts, the button
appears, the page 404s, and nothing anywhere says why.

## Expected Outcome

- An install that enables the dashboard builds it.
- A running bot that was told to serve a dashboard it does not have says so, by
  name, at startup and in the browser — instead of a bare 404.
- The Mini App button is not offered for a dashboard that is not there.

## Out of Scope

- Changing the default. `WITH_DASHBOARD=false` is right for a small host, and
  the operator's answer is to turn it on for theirs.

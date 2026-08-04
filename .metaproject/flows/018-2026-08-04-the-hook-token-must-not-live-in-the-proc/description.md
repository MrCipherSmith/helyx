# The hook token must not live in the process argument list

Status: formalized
Source: found while verifying flow 017 on the live system

## Problem

The shared secret between the question hook and the bot was passed to curl as
`-H "x-helyx-hook-token: …"`. That puts it in the process's argument list, where
every `ps` on the machine can read it — and where it stays for as long as the
question is open, which is up to ten minutes.

It was found the plainest way possible: a `pgrep -af` run while debugging
printed the whole command line, token included, into a transcript.

What it guards is not trivial. That endpoint sends a message to the operator's
chat and then holds a connection open. Any local process could have read the
token and used it.

## Expected Outcome

The bot writes a curl config file beside the token — same directory, same 0600 —
containing the header line, and the hook passes `--config` instead of `-H`. The
secret never appears in argv.

The config is written on every read, not only on creation: an installation that
already has a token and no config would otherwise have a hook that cannot
authenticate, and questions would silently stop arriving.

## Out of Scope

Rotating the leaked token is an operational step for the maintainer, recorded
in the report rather than performed here — deleting the file mid-session would
break the hook for any question already in flight.

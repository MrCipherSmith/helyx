# Flow Journal

- 2026-08-04T08:16:41.405Z - flow created
- 2026-08-04T08:16:41.500Z - task-added: T5: curl config beside the token
- 2026-08-04T08:16:41.585Z - task-added: T6: hook uses --config
- 2026-08-04T08:16:41.670Z - task-added: T7: tests
- 2026-08-04T08:16:41.755Z - frozen: 5 criteria; checksum recorded
- 2026-08-04T08:16:41.840Z - started

## What happened

Found the plainest way possible. While verifying flow 017 on the live system I
ran `pgrep -af` to see whether the hook's curl was still alive, and the output
printed the whole command line — token included — straight into the transcript.

It was never a leak caused by that command. The token had been readable by every
process on the machine, for the lifetime of every question, since the day the
endpoint was written. `pgrep` only showed me what `ps` had been showing anyone
who looked.

What it guards is not trivial: the endpoint sends a message to the operator's
chat and then holds a connection open for up to ten minutes.

A curl config file fixes it — same directory as the token, same 0600, read by
`--config`. Written on every read rather than only on creation, because an
installation that already has a token and no config would have a hook that
cannot authenticate, and questions would simply stop arriving with nothing said.

### The verification that produced it

Worth recording separately, because two other things came out of the same run.

The timeout path works: the probe question expired at 08:15:12, exactly its
570 seconds, and the keyboard came down.

The **disconnect** path does not. I killed the hook's curl outright and the
request kept waiting to its full deadline — so `res.on("close")` never fired.
The endpoint runs under Bun's `node:http` shim, and the close event that Node
guarantees does not appear to arrive there. The unit tests pass because they
drive the service directly with a `clientGone` predicate; nothing they assert is
wrong, and none of it proves the predicate is ever true in production.

Recorded as open. The user-visible fix — buttons retire when the wait ends —
works through the timeout, which is the path that actually fires.
- 2026-08-04T08:17:04.165Z - task-done: T1: Collect remaining context
- 2026-08-04T08:17:04.250Z - task-done: T2: Implement per plan
- 2026-08-04T08:17:04.337Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-04T08:17:04.422Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-04T08:17:04.509Z - task-done: T5: curl config beside the token
- 2026-08-04T08:17:04.594Z - ac-confirmed: AC1: readOrCreateToken writes helyx-hook-curl.conf beside the token, both via the same 0600 writer
- 2026-08-04T08:17:04.679Z - ac-confirmed: AC2: an existing token also gets a config written — asserted with a store pre-seeded with only the token
- 2026-08-04T08:17:04.768Z - ac-confirmed: AC3: the hook passes --config and exits 0 when it is unreadable; no -H carrying the token remains
- 2026-08-04T08:17:04.855Z - ac-confirmed: AC4: curlConfigFor asserted to be exactly one header line
- 2026-08-04T08:17:04.941Z - ac-confirmed: AC5: typecheck clean, lint 0 errors, 991 tests, dupes 2 documented

### Review: the mode was applied only on creation

`writeFileSync(path, contents, { mode: 0o600 })` sets the mode when it creates
the file and ignores it otherwise. A config or token that already existed with
looser permissions kept them — which is precisely and only what this change was
about. An explicit `chmodSync` follows every write now, and a test starts from
0644 on a real file and asserts it ends at 0600.

The second round found the same thing still open, and it was fair. When the
token was already valid the function only *read* it, so the file kept whatever
mode it had — the config was hardened and the secret itself was not. And my test
mirrored the writer rather than calling `readOrCreateToken`, so it never entered
that branch and passed while the real case stayed open. That is the same defect
as the UTF-8 test in flow 014 and the three boundary tests in flow 016: the test
exercised the shape of the case instead of the case.

Now the existing token is re-written with identical content, which is what
applies the permissions, and the tests go through `readOrCreateToken` against a
real filesystem starting from 0644. Mutation-checked: remove the re-write and
one test fails.
- 2026-08-04T08:30:52.252Z - ac-confirmed: AC1: config written beside the token; both forced to 0600 by an explicit chmod after every write
- 2026-08-04T08:30:52.340Z - ac-confirmed: AC2: an existing token is re-written and re-hardened, and gets a config; asserted through readOrCreateToken on a real 0644 file
- 2026-08-04T08:30:52.429Z - ac-confirmed: AC5: typecheck clean, lint 0 errors, 993 tests, dupes 2 documented

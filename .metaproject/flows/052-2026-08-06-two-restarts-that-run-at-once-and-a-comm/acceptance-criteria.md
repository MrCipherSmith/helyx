# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Taking the lease is atomic — of two takers racing on the same path, exactly one succeeds and the other is told it is held, with no window in which both believe they hold it.
- AC2: A lease that is held refuses the next taker with the owner's name and how long it has been held, so a refusal says what to wait for rather than only that the answer is no.
- AC3: A lease older than the stated expiry may be broken by the next taker, and the break is logged with the previous owner and its age — a restart that died does not wedge the stack for ever.
- AC4: A lease younger than the expiry is never broken, so a live restart cannot have the ground taken from under it by an operator pressing a second button.
- AC5: Releasing the lease lets the next take succeed immediately, and releasing a lease that is not held is not an error.
- AC6: `bounce`, `host_restart` and `full_restart` each take the lease before spawning anything, and each refuses — spawning nothing — when it is held by any of the three; the mutual exclusion is between restarts, not between rows of the same name.
- AC7: The three commands no longer report `ok` at spawn time: the queue row stays `processing` while the detached work runs and is closed by the work itself, so the operator-facing "уже выполняется" check stops passing a second press through a one-second window.
- AC8: `/up` through `scripts/host-ingress.ts` takes the same lease as the daemon and answers that a restart is in flight rather than starting a second bring-up over it — the guard holds with the database unreachable, which is the state that door exists for.
- AC9: `bun test tests/unit/` passes, `bunx tsc --noEmit` is clean, and new tests cover AC1 through AC5 against a real temporary directory rather than a fake filesystem.

# Implementation Plan

Status: formalized

## Approach

Move the question, not just the flag. Flipping `docker ps` to `docker ps -a` in
`collectSystemSnapshot` would make today's output correct and leave two call
sites free to disagree tomorrow — which is exactly the shape of the defect.

`utils/supervisor-status.ts` already holds every pure decision this involves:
`parseContainerLine`, `isOurContainer`, `classifyContainer`,
`dockerListingUsable`. It gains the one impure step that binds them:

```ts
export type RunShell = (cmd: string) => Promise<{ ok: boolean; output: string }>;
export const DOCKER_LIST_COMMAND = `docker ps -a --format '…' 2>/dev/null || true`;

export interface OwnedContainer { name: string; status: string; health: ContainerHealth }
export async function listOwnedContainers(
  runShell: RunShell,
  scope: { composeProject: string; projects: readonly string[] },
): Promise<{ usable: boolean; containers: OwnedContainer[] }>;
```

`runShell` is a parameter, so the function is testable without Docker — the
same shape `sendStatusBroadcast` already uses.

Both consumers then render the same state differently, which is the only thing
they should have been doing differently all along: the broadcast emits
`🟢/🔴 name — status` as HTML, the snapshot emits `name\tstatus` as plain text.

`RunShell` currently lives as a local type in `scripts/supervisor.ts`. It moves
to the utils module and is imported back, rather than declared twice —
`bun run dupes` exists to catch precisely that.

### Rejected alternatives

- **Flip the flag in place.** One-word fix, leaves the duplication that caused
  the defect.
- **Have the snapshot call `sendStatusBroadcast`'s internals.** Couples a
  ten-minute analyst to a five-minute Telegram broadcast; they share a question,
  not a purpose.
- **Keep the snapshot unfiltered by ownership.** It would then disagree with the
  broadcast about what "our containers" means, which is the same defect wearing
  a different hat.

## Steps

1. `listOwnedContainers` + `RunShell` + `DOCKER_LIST_COMMAND` in
   `utils/supervisor-status.ts`.
2. `sendStatusBroadcast` uses it, rendering unchanged.
3. `collectSystemSnapshot(sql, runShell)` uses it; `checkGemmaHealth` threads
   the `runShell` it already has in scope.
4. Tests with a fake `runShell`: an exited container reaches both consumers, a
   foreign container reaches neither, an unreadable listing is reported as such.
5. CHANGELOG entry.

## Risks

- **The analyst's snapshot changes shape.** It gains exited containers and loses
  foreign ones. That is the intent, and the prompt asks for judgement rather
  than for a fixed format.
- **An unreadable listing now says "unavailable" where it said "no
  containers".** A behaviour change, and the honest one: the two are not the
  same state and the broadcast has distinguished them since flow 004.

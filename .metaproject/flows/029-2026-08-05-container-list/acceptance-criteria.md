# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `scripts/supervisor.ts` issues no `docker ps` command of its own — the only occurrences of the string there are prose, the command is `DOCKER_LIST_COMMAND` in `utils/supervisor-status.ts`, and both consumers reach Docker only through `listOwnedContainers`; verified by grep.
- AC2: `listOwnedContainers` returns an exited container with `health.healthy === false`, proved by test with a fake `runShell`.
- AC3: `listOwnedContainers` excludes a container belonging to another compose project, proved by test.
- AC4: `listOwnedContainers` reports `usable: false` for output that carries no listing line, and `usable: true` with an empty container list for a readable listing containing nothing of ours; both proved by test.
- AC5: The Gemma snapshot contains an exited container, proved by test driving the real `collectSystemSnapshot` with a fake `runShell`.
- AC6: The Gemma snapshot reports an unreadable listing as unavailable rather than as an absence of containers, proved by test.
- AC7: The status broadcast's rendered output is unchanged for a given listing — same icons, same order, same text; the existing broadcast tests pass unmodified.
- AC8: `RunShell` is declared once in the repository; `scripts/supervisor.ts` imports it.
- AC9: Whole unit suite green and `tsc --noEmit` clean.
- AC10: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC11: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.

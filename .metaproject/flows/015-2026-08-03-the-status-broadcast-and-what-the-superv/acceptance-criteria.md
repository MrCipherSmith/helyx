# Acceptance Criteria

## Criteria

- AC1: `isOurContainer` accepts helyx's own stack and a project's containers, and rejects a container merely containing one of those names.
- AC2: `parseContainerLine` reads a name and status, and returns null for a line that is not a listing.
- AC3: The broadcast asks docker for stopped containers as well as running ones.
- AC4: A crashed container is reported red and a healthy one green, from the classified status rather than from the rendered line.
- AC5: Containers outside the scope are left out of the report entirely.
- AC6: The container status is HTML-escaped before it reaches a `parse_mode: HTML` send.
- AC7: An unusable docker listing is still reported rather than read as an empty host.
- AC8: The broadcast is asserted whether it was sent or edited — the loop edits in place while healthy and only sends afresh on a problem.
- AC9: `FakeSql` carries `sql.json`, so a statement that uses it is issued rather than throwing while its arguments are built; the two test files that added it by hand no longer do.
- AC10: `bun run typecheck`, `bun run lint`, `bun test` pass; `dupes` still 1; `scripts/supervisor.ts` line coverage above 45%, up from 32.07%.

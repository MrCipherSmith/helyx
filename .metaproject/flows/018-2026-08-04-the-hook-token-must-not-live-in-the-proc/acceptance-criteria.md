# Acceptance Criteria

## Criteria

- AC1: `readOrCreateToken` writes a curl config file containing the header line, beside the token and with the same permissions.
- AC2: The config is written when the token already exists, so an installation that predates it is repaired rather than silently broken.
- AC3: The hook passes `--config` and no longer passes the token as an argument; it exits silently when the config is unreadable.
- AC4: The config's contents are exactly one header line curl accepts.
- AC5: `bun run typecheck`, `bun run lint`, `bun test` pass; `dupes` reports the two documented pairs.

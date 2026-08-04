# Acceptance Criteria

## Criteria

- AC1: `expireRequest` claims the request atomically and edits every message it placed, removing the keyboard and adding a line saying the question is no longer waiting.
- AC2: A request already answered or already expired is left untouched — no edit, because editing an answered question back to "expired" would be a lie.
- AC3: Every path that ends a wait uses it: the timeout, the client going away mid-wait, and the client going away during registration.
- AC4: The edit carries an empty inline keyboard, so the buttons are gone rather than annotated.
- AC5: `bun run typecheck`, `bun run lint`, `bun test` pass; `dupes` reports the two documented pairs.

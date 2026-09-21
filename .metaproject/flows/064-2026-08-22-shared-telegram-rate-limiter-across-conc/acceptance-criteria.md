# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: All outbound Telegram calls (send, edit, delete, sendChatAction) from every `channel.ts` subprocess acquire a shared budget slot before hitting the network — verified by code reading showing every call site in `channel/telegram.ts` and `utils/typing.ts` routed through the new acquire helper.
- AC2: A load test with 4+ simulated concurrent callers hammering the acquire helper never exceeds the configured shared budget (measured request timestamps, no gaps required beyond the configured floor).
- AC3: A live 24h observation window on at least one restarted project session shows zero `"Telegram rate limit — retrying"` log lines in its `channel-<project>.log`, under normal multi-project concurrent use (not an artificially idle group).
- AC4: If Postgres is briefly unreachable, outbound Telegram sends still go through (fail-open, with a logged warning) rather than being silently dropped or blocked indefinitely.
- AC5: Existing unit test suite (`bun test tests/unit/`) and `bun run typecheck` pass with no new failures beyond the two known pre-existing TTS-environment failures.

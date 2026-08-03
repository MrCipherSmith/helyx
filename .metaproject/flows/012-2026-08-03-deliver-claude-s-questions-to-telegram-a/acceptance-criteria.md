# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected.
- Completion requires every ACn confirmed via `keryx flow ac confirm`.

## Criteria

- AC1: `utils/ask-question.ts` parses the hook payload into questions and options, and returns null — meaning "do nothing, let the terminal have it" — for another tool, for unparseable input, and for a question with no options.
- AC2: A Telegram message is built per question carrying the question, the numbered options and their descriptions, with one button per option; everything the caller wrote is HTML-escaped.
- AC3: Callback payloads round-trip and stay within Telegram's 64-byte limit; a payload belonging to another feature is not mistaken for one of ours.
- AC4: The answer returned to Claude is a `PreToolUse` deny whose reason names each question with the option chosen for it.
- AC5: A call is answered only when every question has an answer, and option index zero counts as an answer.
- AC6: `services/ask-question.ts` resolves the target chat by working directory — not by Claude's session id, which matches no column — and prefers a forum topic when one is configured.
- AC7: The request row is written before the first message is sent, so a button tapped immediately finds a row to write into.
- AC8: When there is nowhere to send, or every send fails, the request is withdrawn rather than left to time out.
- AC9: Each tapped button writes to its own slot, edits its message to show the choice, and returns a distinct outcome for every refusal — no silent no-ops.
- AC10: Waiting returns the answers once complete, and null on timeout, on a vanished request, or on stored values that are not option indices.
- AC11: The endpoint at `/api/hooks/ask-question` is local-only, blocks until answered, and replies 204 on every path where the terminal should keep the question.
- AC12: The hook script prints nothing and exits 0 whenever it cannot deliver — unreachable bot, timeout, or a non-question payload — so the terminal selector is never taken away.
- AC13: `checkHungSessions` skips a session with an unanswered question, and the query is time-bounded so a stale row cannot mute the supervisor indefinitely.
- AC14: The setup wizard registers the hook under `PreToolUse` with matcher `AskUserQuestion` and a 600s timeout, is idempotent, and refuses to register from an ephemeral checkout.
- AC15: `bun run typecheck`, `bun run lint` and `bun test` pass, and `bun run dupes` still reports exactly 1.

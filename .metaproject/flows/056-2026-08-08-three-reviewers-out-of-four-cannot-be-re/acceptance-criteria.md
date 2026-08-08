# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `ReviewerKind` includes `"claude"`, and a reviewer of that kind is dispatched to the Claude Code CLI rather than to a provider HTTP call.
- AC2: The Claude CLI reviewer runs with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` absent from its environment, so a session bound to a third-party provider cannot route the independent review back through that provider.
- AC3: The Claude CLI reviewer runs with `CHANNEL_SOURCE` absent from its environment and with the global MCP servers not loaded, so running a review cannot take the channel lease of the session that requested it.
- AC4: The OpenAI-compatible route for a provider is resolved from an explicit vendor map — `openrouter.ai` to `/api/v1/chat/completions`, `api.z.ai` to `/api/paas/v4/chat/completions`, `api.moonshot.ai` to `/v1/chat/completions` — with the previous suffix-stripping kept as the fallback for an unknown vendor.
- AC5: A provider response carrying HTTP 200 with an error envelope in the body is reported as that error, naming it, rather than as an empty response.
- AC6: `/reviewers_add claude [model]` registers the new reviewer, and `/reviewers` renders it without saying `provider #undefined`.
- AC7: `bun run lint`, `bun run typecheck` and `bun test tests/unit/` all pass.

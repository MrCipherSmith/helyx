# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: No file added or modified by this flow reads or writes anything under `~/.claude/`, and no shell profile or machine-wide Claude Code setting is touched.
- AC2: A project with no provider selection launches exactly as before — `tests/unit/resolve-provider-env.test.ts` passes unmodified, and no existing provider file needs a change.
- AC3: A non-streaming `/v1/messages` request carrying a system prompt, a two-turn history and one tool definition produces a valid Anthropic response body, and the Ollama request built from it carries the system message, the tool in `function` form, and an explicit `options.num_ctx` equal to the model's own context length.
- AC4: A streaming request emits the Anthropic SSE sequence in order (message_start, content_block_start/delta/stop, message_delta, message_stop) with `stop_reason: "tool_use"` when the turn contains a tool call and `end_turn` when it does not.
- AC5: A tool_use to tool_result round trip preserves the pairing, and an unresolvable `tool_use_id` yields an Anthropic `invalid_request_error` rather than a dropped block.
- AC6: Ollama being unreachable produces an Anthropic-shaped error body naming the cause with a non-2xx status — not a hang and not an empty 200.
- AC7: `GET /v1/models` returns a body that the real `parseModelsResponse()` parses to a non-empty list, and `POST /v1/messages/count_tokens` returns a number for a well-formed body.
- AC8: A request naming a model Ollama does not have is served with the configured default; one naming a model it does have uses that model.
- AC9: With `OLLAMA_PROXY_ENABLED` unset, `helyx up` starts no proxy process and writes no `ollama-proxy` health row; when enabled the daemon binds `127.0.0.1` only, exits non-zero naming the port if it is taken, and writes a `process_health` row named `ollama-proxy`.
- AC10: `bun run lint`, `bun run typecheck` and `bun test tests/unit/` all pass.
